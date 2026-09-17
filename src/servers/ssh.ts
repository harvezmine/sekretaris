import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import ssh2 from "ssh2";
import { config } from "../config.js";
import type { SshServer } from "./registry.js";

export interface ExecResult {
  output: string;
  code: number | null;
  timedOut: boolean;
  truncated: boolean;
}

// ssh2 is CommonJS without statically detectable named exports.
const { Client } = ssh2;

export class SshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshError";
  }
}

/** Same format as `ssh-keygen -lf`: SHA256 over the raw public key blob, base64 without padding. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function knownHostsFile(): string {
  return path.join(config.DATA_DIR, "known_hosts.json");
}

async function readKnownHosts(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(knownHostsFile(), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

async function rememberHost(id: string, fp: string): Promise<void> {
  const known = await readKnownHosts();
  if (known[id] === fp) return;
  known[id] = fp;
  const file = knownHostsFile();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(known, null, 2)}\n`);
  await rename(tmp, file);
}

export async function sshExec(
  server: SshServer,
  command: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? 256_000;

  let privateKey: Buffer | string | undefined = server.privateKey;
  if (!privateKey && server.keyPath) {
    try {
      privateKey = await readFile(server.keyPath);
    } catch (err) {
      throw new SshError(`Kunci SSH untuk ${server.name} tidak bisa dibaca (${(err as NodeJS.ErrnoException).code ?? "error"}).`);
    }
  }

  const hostId = `${server.displayHost ?? server.host}:${server.port}`;
  const expected = server.hostKey ?? (server.rememberHostKey ? undefined : (await readKnownHosts())[hostId]);
  const remember = server.rememberHostKey ?? ((fp: string) => rememberHost(hostId, fp));
  let seen: string | undefined;

  return new Promise<ExecResult>((resolve, reject) => {
    const conn = new Client();
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      fn();
    };
    const collect = (d: Buffer) => {
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const piece = d.subarray(0, maxBytes - bytes);
      if (piece.length < d.length) truncated = true;
      chunks.push(piece);
      bytes += piece.length;
    };
    const result = (code: number | null, timedOut: boolean): ExecResult => ({
      output: Buffer.concat(chunks).toString("utf8"),
      code,
      timedOut,
      truncated,
    });

    const timer = setTimeout(() => finish(() => resolve(result(null, true))), timeoutMs);

    const run = () =>
      conn.exec(command, (err, stream) => {
        if (err) return finish(() => reject(new SshError(`Perintah gagal dijalankan: ${err.message}`)));
        let code: number | null = null;
        stream.on("data", collect);
        stream.stderr.on("data", collect);
        stream.on("exit", (c: number | null) => {
          code = c;
        });
        stream.on("close", () => finish(() => resolve(result(code, false))));
      });

    conn.on("ready", () => {
      if (!expected && seen) {
        remember(seen)
          .catch(() => {})
          .finally(run);
      } else {
        run();
      }
    });

    conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, reply) => {
      reply(prompts.map(() => server.password ?? ""));
    });

    conn.on("error", (err: Error & { level?: string }) => {
      const reason =
        seen && expected && seen !== expected
          ? `Sidik jari host ${hostId} berubah (tercatat ${expected}, sekarang ${seen}). Koneksi dibatalkan demi keamanan. ${server.rememberHostKey ? "Bila server memang diganti, hapus server ini dari Milo lalu tambahkan lagi." : "Bila server memang diganti, perbarui host_key atau hapus entrinya dari known_hosts.json."}`
          : err.level === "client-authentication"
            ? `Login SSH ke ${server.user}@${hostId} ditolak. ${server.password && !privateKey ? "Periksa password-nya." : "Pastikan public key Milo sudah dipasang di ~/.ssh/authorized_keys milik user itu."}`
            : err.level === "client-timeout"
              ? `Tidak ada respons dari ${hostId} dalam batas waktu.`
              : `Koneksi SSH ke ${hostId} gagal: ${err.message}`;
      finish(() => reject(new SshError(reason)));
    });

    conn.connect({
      host: server.host,
      port: server.port,
      username: server.user,
      ...(privateKey ? { privateKey } : {}),
      ...(server.passphrase ? { passphrase: server.passphrase } : {}),
      ...(server.password ? { password: server.password, tryKeyboard: true } : {}),
      readyTimeout: 10_000,
      hostVerifier: (key: Buffer) => {
        seen = fingerprint(key);
        return !expected || seen === expected;
      },
    });
  });
}
