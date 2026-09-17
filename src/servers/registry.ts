import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { normalizePhone } from "../util.js";

export interface DockerServer {
  kind: "docker";
  name: string;
  description: string;
  proxyUrl: string;
}

/** Where an app writes its logs. Each type maps to one fixed read-only command in checks.ts. */
export type LogSource =
  | { type: "docker"; container: string }
  | { type: "compose"; dir: string; service?: string | undefined }
  | { type: "systemd"; unit: string }
  | { type: "file"; path: string }
  | { type: "pm2"; name: string };

export interface AppConfig {
  /** "<server>/<app>", the id the model uses. */
  id: string;
  name: string;
  server: string;
  description: string;
  logs: LogSource;
}

export interface SshServer {
  kind: "ssh";
  name: string;
  description: string;
  /** The address dialled. For user servers this is the already-checked IP; displayHost keeps what the user typed. */
  host: string;
  displayHost?: string;
  port: number;
  user: string;
  keyPath?: string;
  /** In-memory OpenSSH private key (user servers, decrypted from the database). */
  privateKey?: string;
  passphrase?: string;
  password?: string;
  apps: AppConfig[];
  /** OpenSSH-style SHA256 fingerprint; when absent the first key seen is trusted and remembered. */
  hostKey?: string;
  /** Where a first-seen host key is remembered; defaults to data/known_hosts.json. */
  rememberHostKey?: (fingerprint: string) => Promise<void>;
}

export type ServerTarget = DockerServer | SshServer;

export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SSH_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
export const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const UNIT = /^[A-Za-z0-9_@][A-Za-z0-9_@.:-]{0,99}$/;
export const ABS_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))\/[A-Za-z0-9._\/-]{0,300}$/;

const entrySchema = z.object({
  name: z.string().regex(NAME, "huruf kecil, angka dan tanda minus saja"),
  description: z.string().max(200).default(""),
  host: z.string().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  user: z.string().regex(SSH_USER),
  key: z.string().min(1).optional(),
  passphrase_env: z.string().optional(),
  password_env: z.string().optional(),
  host_key: z
    .string()
    .regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "format SHA256:... seperti keluaran ssh-keygen -lf")
    .optional(),
  apps: z
    .array(
      z.object({
        name: z.string().regex(NAME, "huruf kecil, angka dan tanda minus saja"),
        description: z.string().max(200).default(""),
        logs: z.discriminatedUnion("type", [
          z.object({ type: z.literal("docker"), container: z.string().regex(CONTAINER, "nama container tidak valid") }),
          z.object({
            type: z.literal("compose"),
            dir: z.string().regex(ABS_PATH, "harus path absolut tanpa spasi atau '..'"),
            service: z.string().regex(CONTAINER, "nama service tidak valid").optional(),
          }),
          z.object({ type: z.literal("systemd"), unit: z.string().regex(UNIT, "nama unit tidak valid") }),
          z.object({ type: z.literal("file"), path: z.string().regex(ABS_PATH, "harus path absolut tanpa spasi atau '..'") }),
          z.object({ type: z.literal("pm2"), name: z.string().regex(CONTAINER, "nama proses pm2 tidak valid") }),
        ]),
      }),
    )
    .default([]),
});

const fileSchema = z.object({ servers: z.array(z.unknown()).default([]) });

export interface Registry {
  servers: ServerTarget[];
  problems: string[];
}

export function loadRegistry(): Registry {
  const servers: ServerTarget[] = [];
  const problems: string[] = [];

  if (config.DOCKER_PROXY_URL) {
    servers.push({
      kind: "docker",
      name: config.LOCAL_SERVER_NAME,
      description: "the machine Milo itself runs on (read through Docker)",
      proxyUrl: config.DOCKER_PROXY_URL.replace(/\/+$/, ""),
    });
  }

  const file = path.resolve(config.SERVERS_FILE);
  let raw: string | undefined;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${file} tidak bisa dibaca: ${(err as Error).message}`);
  }
  if (raw !== undefined) {
    let entries: unknown[] = [];
    try {
      const result = fileSchema.safeParse(JSON.parse(raw));
      if (result.success) entries = result.data.servers;
      else problems.push(`${file}: harus berbentuk {"servers": [...]}`);
    } catch (err) {
      problems.push(`${file} bukan JSON yang valid: ${(err as Error).message}`);
    }
    for (const [index, entry] of entries.entries()) {
      const result = entrySchema.safeParse(entry);
      if (!result.success) {
        const label = (entry as { name?: unknown } | null)?.name;
        problems.push(
          `server ${typeof label === "string" ? `"${label}"` : `#${index + 1}`} diabaikan: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
        );
        continue;
      }
      const s = result.data;
      if (servers.some((t) => t.name === s.name)) {
        problems.push(`nama server "${s.name}" dipakai lebih dari sekali; yang berikutnya diabaikan`);
        continue;
      }
      const fromEnv = (name: string | undefined) => {
        if (!name) return undefined;
        const value = process.env[name];
        if (!value) problems.push(`${s.name}: variabel ${name} kosong`);
        return value || undefined;
      };
      const passphrase = fromEnv(s.passphrase_env);
      const password = fromEnv(s.password_env);
      if (!s.key && !password) {
        problems.push(`server "${s.name}" diabaikan: isi "key" atau "password_env"`);
        continue;
      }
      const apps: AppConfig[] = [];
      for (const a of s.apps) {
        if (apps.some((x) => x.name === a.name)) {
          problems.push(`${s.name}: aplikasi "${a.name}" dipakai lebih dari sekali; yang berikutnya diabaikan`);
          continue;
        }
        apps.push({ id: `${s.name}/${a.name}`, name: a.name, server: s.name, description: a.description, logs: a.logs });
      }
      servers.push({
        kind: "ssh",
        name: s.name,
        description: s.description,
        host: s.host,
        port: s.port,
        user: s.user,
        ...(s.key ? { keyPath: path.resolve(path.dirname(file), s.key) } : {}),
        ...(passphrase ? { passphrase } : {}),
        ...(password ? { password } : {}),
        ...(s.host_key ? { hostKey: s.host_key } : {}),
        apps,
      });
    }
  }
  return { servers, problems };
}

let cached: Registry | undefined;

export function registry(): Registry {
  cached ??= loadRegistry();
  return cached;
}

/** For tests and the CLI; the running app reads the registry once so the admin tool list stays byte-stable. */
export function resetRegistry(): void {
  cached = undefined;
}

export function findServer(name: string): ServerTarget | undefined {
  return registry().servers.find((s) => s.name === name);
}

export function allApps(): AppConfig[] {
  return registry().servers.flatMap((s) => (s.kind === "ssh" ? s.apps : []));
}

export function findApp(id: string): { app: AppConfig; server: SshServer } | undefined {
  for (const server of registry().servers) {
    if (server.kind !== "ssh") continue;
    const app = server.apps.find((a) => a.id === id);
    if (app) return { app, server };
  }
  return undefined;
}

export function adminNumbers(): Set<string> {
  return new Set(
    config.SERVER_ADMIN_NUMBERS.split(",")
      .map((n) => normalizePhone(n.trim()))
      .filter((n): n is string => Boolean(n)),
  );
}

/** Admins also see the servers in servers.json and the Docker host Milo runs on. */
export function isServerAdmin(waId: string): boolean {
  return adminNumbers().has(waId);
}

/** Whether this user gets the server tools at all. */
export function serverToolsFor(waId: string): boolean {
  switch (config.SERVER_ACCESS) {
    case "all":
      return true;
    case "admin":
      return isServerAdmin(waId);
    default:
      return false;
  }
}
