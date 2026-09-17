import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import ssh2 from "ssh2";
import { config } from "../config.js";

export class ServerSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerSetupError";
  }
}

function sealingKey(): Buffer {
  if (config.SERVER_KEY_SECRET.length < 32) {
    throw new ServerSetupError("Penyimpanan kunci server belum dikonfigurasi (SERVER_KEY_SECRET).");
  }
  return createHash("sha256").update(config.SERVER_KEY_SECRET).digest();
}

/** AES-256-GCM; the stored form is `v1:<iv>:<tag>:<ciphertext>` in base64. */
export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

export function openSecret(sealed: string): string {
  const [version, iv, tag, body] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || !body) throw new ServerSetupError("Format kunci tersimpan tidak dikenal.");
  const decipher = createDecipheriv("aes-256-gcm", sealingKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new ServerSetupError("Kunci tersimpan tidak bisa dibuka; SERVER_KEY_SECRET mungkin berubah.");
  }
}

export function generateServerKey(comment: string): { privateKey: string; publicKey: string } {
  const pair = ssh2.utils.generateKeyPairSync("ed25519", { comment });
  return { privateKey: pair.private, publicKey: pair.public.trim() };
}

/** The line the user appends to authorized_keys: `restrict` turns off forwarding and interactive terminals. */
export function authorizedKeyLine(publicKey: string): string {
  return `restrict ${publicKey}`;
}

export function installCommand(publicKey: string): string {
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${authorizedKeyLine(publicKey)}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const ip = mapped ?? address;
  const family = isIP(ip);
  if (!family) return false;
  return !blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

export const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

export interface AddressPolicy {
  resolve?: Resolver | undefined;
  /** Tests dial a local SSH server; production always uses isPublicAddress. */
  allow?: ((address: string) => boolean) | undefined;
}

/**
 * Servers added by users may only point at the public internet, so Milo cannot be used to reach its own database,
 * the Docker proxy or anything else on the local network. The resolved address is what gets dialled, which also
 * keeps a DNS answer from changing between this check and the connection.
 */
export async function resolvePublicHost(host: string, policy: AddressPolicy = {}): Promise<string> {
  const resolve = policy.resolve ?? systemResolver;
  const allow = policy.allow ?? isPublicAddress;
  const bare = host.replace(/^\[(.*)\]$/, "$1");
  let addresses: string[];
  if (isIP(bare)) {
    addresses = [bare];
  } else {
    if (!HOSTNAME.test(bare) || !bare.includes(".")) throw new ServerSetupError(`"${host}" bukan alamat server yang valid.`);
    try {
      addresses = await resolve(bare);
    } catch {
      throw new ServerSetupError(`Alamat "${host}" tidak ditemukan.`);
    }
  }
  if (!addresses.length) throw new ServerSetupError(`Alamat "${host}" tidak ditemukan.`);
  if (!addresses.every(allow)) {
    throw new ServerSetupError(`"${host}" mengarah ke alamat privat/internal. Hanya server yang bisa diakses dari internet yang didukung.`);
  }
  return addresses[0]!;
}
