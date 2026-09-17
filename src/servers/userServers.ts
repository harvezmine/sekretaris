import { config } from "../config.js";
import { sql, type UserRow } from "../db/index.js";
import {
  generateServerKey,
  HOSTNAME,
  installCommand,
  openSecret,
  resolvePublicHost,
  sealSecret,
  ServerSetupError,
  type AddressPolicy,
} from "./keys.js";
import { findServer, isServerAdmin, NAME, registry, SSH_USER, type ServerTarget, type SshServer } from "./registry.js";

export interface UserServerRow {
  id: string;
  userId: string;
  name: string;
  description: string;
  host: string;
  port: number;
  username: string;
  privateKeyEnc: string;
  publicKey: string;
  hostKey: string | null;
  verifiedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export interface ServerSummary {
  name: string;
  address: string;
  status: string;
  supports: string;
  description?: string;
  apps?: string[];
}

export async function listUserServers(userId: string): Promise<UserServerRow[]> {
  return sql<UserServerRow[]>`select * from user_servers where user_id = ${userId} order by name`;
}

async function getUserServer(userId: string, name: string): Promise<UserServerRow | undefined> {
  const [row] = await sql<UserServerRow[]>`select * from user_servers where user_id = ${userId} and name = ${name}`;
  return row;
}

export interface AddServerInput {
  name: string;
  host: string;
  port?: number | undefined;
  user: string;
  description?: string | undefined;
}

export interface AddServerResult {
  name: string;
  publicKey: string;
  installCommand: string;
  reused: boolean;
}

/**
 * Registers a server for a user with a key pair Milo generates. Adding the same unverified name again updates the
 * address and keeps the key, so a user who mistyped the host does not have to install a second key.
 */
export async function addUserServer(user: UserRow, input: AddServerInput, policy?: AddressPolicy): Promise<AddServerResult> {
  const name = input.name.trim().toLowerCase();
  const host = input.host.trim().toLowerCase();
  const port = input.port ?? 22;
  if (!NAME.test(name)) throw new ServerSetupError("Nama server hanya boleh huruf kecil, angka dan tanda minus, maksimal 40 karakter.");
  if (!SSH_USER.test(input.user)) throw new ServerSetupError(`"${input.user}" bukan nama user SSH yang valid.`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ServerSetupError("Port harus 1–65535.");
  if (!HOSTNAME.test(host.replace(/^\[(.*)\]$/, "$1")) && !host.includes(":")) {
    throw new ServerSetupError(`"${input.host}" bukan alamat server yang valid.`);
  }
  if (isServerAdmin(user.waId) && findServer(name)) {
    throw new ServerSetupError(`Nama "${name}" sudah dipakai server di konfigurasi. Pilih nama lain.`);
  }
  await resolvePublicHost(host, policy);

  const description = input.description?.trim().slice(0, 200) ?? "";
  const existing = await getUserServer(user.id, name);
  if (existing?.verifiedAt) {
    throw new ServerSetupError(`Server "${name}" sudah terhubung. Hapus dulu bila ingin mengganti alamat atau user-nya.`);
  }
  if (existing) {
    await sql`
      update user_servers
      set host = ${host}, port = ${port}, username = ${input.user}, description = ${description || existing.description},
          host_key = null, last_error = null
      where id = ${existing.id}
    `;
    return { name, publicKey: existing.publicKey, installCommand: installCommand(existing.publicKey), reused: true };
  }

  const [{ count } = { count: "0" }] = await sql<{ count: string }[]>`
    select count(*) from user_servers where user_id = ${user.id}
  `;
  if (Number(count) >= config.USER_SERVER_LIMIT) {
    throw new ServerSetupError(`Maksimal ${config.USER_SERVER_LIMIT} server per pengguna. Hapus salah satu dulu.`);
  }

  const key = generateServerKey(`milo-${user.id}-${name}`);
  const sealed = sealSecret(key.privateKey);
  await sql`
    insert into user_servers (user_id, name, description, host, port, username, private_key_enc, public_key)
    values (${user.id}, ${name}, ${description}, ${host}, ${port}, ${input.user}, ${sealed}, ${key.publicKey})
  `;
  return { name, publicKey: key.publicKey, installCommand: installCommand(key.publicKey), reused: false };
}

export async function removeUserServer(user: UserRow, name: string): Promise<boolean> {
  const rows = await sql`delete from user_servers where user_id = ${user.id} and name = ${name} returning id`;
  return rows.length > 0;
}

/** Decrypts the key and re-checks the address just before connecting. */
async function toTarget(row: UserServerRow, policy?: AddressPolicy): Promise<SshServer> {
  const ip = await resolvePublicHost(row.host, policy);
  return {
    kind: "ssh",
    name: row.name,
    description: row.description,
    host: ip,
    displayHost: row.host,
    port: row.port,
    user: row.username,
    privateKey: openSecret(row.privateKeyEnc),
    apps: [],
    ...(row.hostKey ? { hostKey: row.hostKey } : {}),
    rememberHostKey: async (fingerprint) => {
      await sql`update user_servers set host_key = ${fingerprint} where id = ${row.id} and host_key is null`;
    },
  };
}

export interface ResolvedServer {
  target: ServerTarget;
  /** Set for servers stored per user, so the outcome of a check can be recorded. */
  rowId?: string;
}

export async function resolveServer(user: UserRow, name: string, policy?: AddressPolicy): Promise<ResolvedServer | undefined> {
  const row = await getUserServer(user.id, name);
  if (row) return { target: await toTarget(row, policy), rowId: row.id };
  if (isServerAdmin(user.waId)) {
    const configured = findServer(name);
    if (configured) return { target: configured };
  }
  return undefined;
}

export async function recordCheckOutcome(rowId: string, error: string | null): Promise<void> {
  if (error) {
    await sql`update user_servers set last_error = ${error.slice(0, 500)} where id = ${rowId}`;
  } else {
    await sql`update user_servers set verified_at = coalesce(verified_at, now()), last_error = null where id = ${rowId}`;
  }
}

const SSH_SUPPORTS = "all checks";

export async function summarizeServers(user: UserRow, dockerChecks: readonly string[]): Promise<ServerSummary[]> {
  const own = (await listUserServers(user.id)).map(
    (r): ServerSummary => ({
      name: r.name,
      address: `${r.username}@${r.host}:${r.port}`,
      status: r.verifiedAt
        ? r.lastError
          ? `terhubung, tapi cek terakhir gagal: ${r.lastError}`
          : "terhubung"
        : r.lastError
          ? `belum terhubung: ${r.lastError}`
          : "menunggu kunci Milo dipasang di server",
      supports: SSH_SUPPORTS,
      ...(r.description ? { description: r.description } : {}),
    }),
  );
  if (!isServerAdmin(user.waId)) return own;
  const configured = registry().servers.map(
    (s): ServerSummary =>
      s.kind === "docker"
        ? {
            name: s.name,
            address: "Docker di mesin Milo",
            status: "diatur operator",
            supports: dockerChecks.join(", "),
            description: s.description,
          }
        : {
            name: s.name,
            address: `${s.user}@${s.host}:${s.port}`,
            status: "diatur operator",
            supports: SSH_SUPPORTS,
            ...(s.description ? { description: s.description } : {}),
            ...(s.apps.length
              ? { apps: s.apps.map((a) => `${a.name}${a.description ? ` (${a.description})` : ""}: ${logHint(a.logs)}`) }
              : {}),
          },
  );
  return [...configured, ...own];
}

function logHint(source: SshServer["apps"][number]["logs"]): string {
  switch (source.type) {
    case "docker":
      return `check=container_logs target=${source.container}`;
    case "compose":
      return `check=compose_logs target=${source.dir}${source.service ? ` service=${source.service}` : ""}`;
    case "systemd":
      return `check=service_logs target=${source.unit}`;
    case "file":
      return `check=file_logs target=${source.path}`;
    case "pm2":
      return `check=pm2_logs target=${source.name}`;
  }
}
