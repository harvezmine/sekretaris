import { ACTION_MINUTES, type PendingAction } from "../actions/pending.js";
import { config } from "../config.js";
import { sql, type UserRow } from "../db/index.js";
import { clip, redact } from "./checks.js";
import { ServerSetupError, type AddressPolicy } from "./keys.js";
import { isServerAdmin } from "./registry.js";
import { sshExec } from "./ssh.js";
import { resolveServer } from "./userServers.js";

/**
 * Running things on a user's own server: deploys, restarts, scripts.
 *
 * Two rules hold this together. The command text is always written by the user — either saved once as a named
 * action or typed for a single run — so the model can ask for an action by name but can never compose a shell
 * command, and an instruction smuggled in through an email or a document cannot reach a server. And nothing runs
 * until the user taps the confirmation button, which the pipeline handles without the model.
 */

export const ACTION_NAME = /^[a-z0-9][a-z0-9-]{0,29}$/;
export const MAX_ACTIONS_PER_SERVER = 20;
const MAX_COMMAND_CHARS = 1000;
const MAX_OUTPUT_CHARS = 3000;
const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 900;
const RUNS_PER_HOUR = 20;

export interface ServerAction {
  name: string;
  command: string;
  description: string;
  timeoutSec: number;
}

export interface ServerRunPayload {
  server: string;
  action: string | null;
  command: string;
  timeoutSec: number;
}

export class ServerActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerActionError";
  }
}

export function serverActionsFor(waId: string): boolean {
  switch (config.SERVER_ACTION_ACCESS) {
    case "all":
      return true;
    case "admin":
      return isServerAdmin(waId);
    default:
      return false;
  }
}

/** A command must be one the user can read back later: no control characters, no novel-length scripts. */
export function cleanCommand(raw: string): string {
  const command = raw.replace(/\r/g, "").trim();
  if (!command) throw new ServerActionError("Perintahnya kosong.");
  if (command.length > MAX_COMMAND_CHARS) throw new ServerActionError(`Perintah maksimal ${MAX_COMMAND_CHARS} karakter.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(command)) throw new ServerActionError("Perintah berisi karakter yang tidak bisa dibaca.");
  return command;
}

function parseActions(value: unknown): ServerAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || typeof e.command !== "string") return [];
    return [
      {
        name: e.name,
        command: e.command,
        description: typeof e.description === "string" ? e.description : "",
        timeoutSec: typeof e.timeoutSec === "number" ? e.timeoutSec : DEFAULT_TIMEOUT_SEC,
      },
    ];
  });
}

async function serverRow(user: UserRow, name: string): Promise<{ id: string; name: string; actions: ServerAction[] } | undefined> {
  const [row] = await sql<{ id: string; name: string; actions: unknown }[]>`
    select id, name, actions from user_servers where user_id = ${user.id} and name = ${name.trim().toLowerCase()}
  `;
  return row ? { id: row.id, name: row.name, actions: parseActions(row.actions) } : undefined;
}

export async function listActions(user: UserRow, serverName: string): Promise<ServerAction[]> {
  return (await serverRow(user, serverName))?.actions ?? [];
}

export async function findAction(user: UserRow, serverName: string, actionName: string): Promise<ServerAction | undefined> {
  const wanted = actionName.trim().toLowerCase();
  return (await listActions(user, serverName)).find((a) => a.name === wanted);
}

/** Saving is deliberate and replaces an action of the same name, so a typo is fixed by saving it again. */
export async function saveAction(
  user: UserRow,
  serverName: string,
  input: { name: string; command: string; description?: string; timeoutSec?: number },
): Promise<ServerAction> {
  const row = await serverRow(user, serverName);
  if (!row) throw new ServerActionError(`Server "${serverName}" belum terhubung. Ketik *KONEKSI* untuk menambahkannya.`);
  const name = input.name.trim().toLowerCase();
  if (!ACTION_NAME.test(name)) throw new ServerActionError("Nama aksi hanya huruf kecil, angka dan tanda minus, maksimal 30 karakter.");
  const timeoutSec = Math.min(Math.max(input.timeoutSec ?? DEFAULT_TIMEOUT_SEC, 5), MAX_TIMEOUT_SEC);
  const action: ServerAction = {
    name,
    command: cleanCommand(input.command),
    description: input.description?.trim().slice(0, 200) ?? "",
    timeoutSec,
  };
  const rest = row.actions.filter((a) => a.name !== name);
  if (rest.length >= MAX_ACTIONS_PER_SERVER) throw new ServerActionError(`Maksimal ${MAX_ACTIONS_PER_SERVER} aksi per server.`);
  const actions = [...rest, action].sort((a, b) => (a.name < b.name ? -1 : 1));
  await sql`update user_servers set actions = ${sql.json(actions as never)} where id = ${row.id}`;
  return action;
}

export async function removeAction(user: UserRow, serverName: string, actionName: string): Promise<boolean> {
  const row = await serverRow(user, serverName);
  if (!row) return false;
  const name = actionName.trim().toLowerCase();
  const actions = row.actions.filter((a) => a.name !== name);
  if (actions.length === row.actions.length) return false;
  await sql`update user_servers set actions = ${sql.json(actions as never)} where id = ${row.id}`;
  return true;
}

export type ServerCommand =
  | { kind: "save"; server: string; name: string; command: string }
  | { kind: "run"; server: string; command: string }
  | { kind: "list"; server?: string }
  | { kind: "forget"; server: string; name: string };

const SAVE = /^aksi\s+([a-z0-9][a-z0-9-]{0,39})\s+([a-z0-9][a-z0-9-]{0,29})\s*[:=]\s*([\s\S]+)$/i;
const FORGET = /^(?:hapus|lupakan)\s+aksi\s+([a-z0-9][a-z0-9-]{0,39})\s+([a-z0-9][a-z0-9-]{0,29})\s*$/i;
const LIST = /^aksi(?:\s+([a-z0-9][a-z0-9-]{0,39}))?\s*$/i;
const RUN = /^(?:jalankan|jalanin|run|eksekusi)\s+(?:di\s+)?([a-z0-9][a-z0-9-]{0,39})\s*[:=]\s*([\s\S]+)$/i;

/**
 * Commands the pipeline answers by itself. The point is authorship: a command only ever reaches a server because
 * the user typed it here, so nothing the model reads — an email, a document, a stranger's reply — can put one there.
 */
export function parseServerCommand(text: string): ServerCommand | undefined {
  const t = text.trim();
  const forget = FORGET.exec(t);
  if (forget) return { kind: "forget", server: forget[1]!.toLowerCase(), name: forget[2]!.toLowerCase() };
  const save = SAVE.exec(t);
  if (save) return { kind: "save", server: save[1]!.toLowerCase(), name: save[2]!.toLowerCase(), command: save[3]! };
  const run = RUN.exec(t);
  if (run) return { kind: "run", server: run[1]!.toLowerCase(), command: run[2]! };
  const list = LIST.exec(t);
  if (list) return list[1] ? { kind: "list", server: list[1].toLowerCase() } : { kind: "list" };
  return undefined;
}

export interface RunOutcome {
  ok: boolean;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Runs one command over SSH and records it, whatever happens. Output is redacted and clipped: a deploy log is
 * long, and a WhatsApp message is not the place to paste a secret that scrolled past.
 */
export async function runServerCommand(user: UserRow, payload: ServerRunPayload, policy?: AddressPolicy): Promise<RunOutcome> {
  const [{ n } = { n: "0" }] = await sql<{ n: string }[]>`
    select count(*) as n from server_runs where user_id = ${user.id} and created_at > now() - interval '1 hour'
  `;
  if (Number(n) >= RUNS_PER_HOUR) throw new ServerActionError(`Batas ${RUNS_PER_HOUR} perintah per jam tercapai. Coba lagi nanti.`);

  const resolved = await resolveServer(user, payload.server, policy);
  if (!resolved) throw new ServerActionError(`Server "${payload.server}" tidak ditemukan.`);
  if (resolved.target.kind !== "ssh") throw new ServerActionError(`Server "${payload.server}" bukan server SSH, jadi tidak bisa menjalankan perintah.`);

  const started = Date.now();
  let outcome: RunOutcome;
  try {
    const result = await sshExec(resolved.target, payload.command, { timeoutMs: payload.timeoutSec * 1000 });
    // A deploy log answers "did it work?" at the end, so the tail is what survives clipping.
    const text = redact(result.output.trim());
    outcome = {
      ok: result.code === 0 && !result.timedOut,
      exitCode: result.code,
      output: clip(text, true, MAX_OUTPUT_CHARS),
      truncated: result.truncated || text.length > MAX_OUTPUT_CHARS,
      durationMs: Date.now() - started,
      ...(result.timedOut ? { error: `Perintah dihentikan setelah ${payload.timeoutSec} detik.` } : {}),
    };
  } catch (err) {
    outcome = {
      ok: false,
      exitCode: null,
      output: "",
      truncated: false,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  await sql`
    insert into server_runs (user_id, server_name, action_name, command, exit_code, duration_ms, output, error)
    values (${user.id}, ${payload.server}, ${payload.action}, ${payload.command}, ${outcome.exitCode}, ${outcome.durationMs},
            ${outcome.output.slice(0, 4000)}, ${outcome.error ?? null})
  `;
  return outcome;
}

export { DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC, RUNS_PER_HOUR, ServerSetupError };

/** What the user reads before deciding: the server, the command itself, and how long it may take. */
export function serverActionPreview(action: PendingAction): string {
  const p = action.payload as unknown as ServerRunPayload;
  return [
    p.action ? `🖥️ *Jalankan "${p.action}" di ${p.server}?*` : `🖥️ *Jalankan perintah ini di ${p.server}?*`,
    "",
    "```",
    p.command,
    "```",
  ].join("\n");
}

export function serverActionQuestion(action: PendingAction): string {
  const p = action.payload as unknown as ServerRunPayload;
  return `Jalankan sekarang di *${p.server}*? Batas waktu ${Math.round(p.timeoutSec / 60)} menit, konfirmasi berlaku ${ACTION_MINUTES} menit.`;
}

export interface ServerActionOutcome {
  ok: boolean;
  text: string;
  note: string;
}

/** Runs a confirmed action and turns the result into something readable in a chat. */
export async function runServerAction(action: PendingAction, user: UserRow): Promise<ServerActionOutcome> {
  const p = action.payload as unknown as ServerRunPayload;
  const what = p.action ? `"${p.action}"` : "perintah";
  try {
    const outcome = await runServerCommand(user, p);
    const seconds = Math.max(1, Math.round(outcome.durationMs / 1000));
    const head = outcome.ok
      ? `✅ ${p.action ? `*${p.action}*` : "Perintah"} selesai di *${p.server}* (${seconds} detik).`
      : `❌ ${p.action ? `*${p.action}*` : "Perintah"} gagal di *${p.server}*${outcome.exitCode === null ? "" : ` (exit ${outcome.exitCode})`}.`;
    const body = outcome.error ?? outcome.output;
    const text = body ? `${head}\n\n\`\`\`\n${body}\n\`\`\`` : `${head} Tidak ada keluaran.`;
    return {
      ok: outcome.ok,
      text,
      note: `[Pengguna menekan Jalankan: ${what} di ${p.server} ${outcome.ok ? "berhasil" : "gagal"}${outcome.error ? `: ${outcome.error}` : ""}]`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, text: `❌ Tidak bisa menjalankan ${what} di *${p.server}*: ${message}`, note: `[Jalankan ${what} di ${p.server} gagal: ${message}]` };
  }
}
