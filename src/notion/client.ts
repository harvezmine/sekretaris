import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { sql } from "../db/index.js";
import { openSecret, sealSecret } from "../servers/keys.js";
import { publicBaseUrl } from "../uploads/links.js";

/**
 * The user's own Notion workspace. Unlike Google, a Notion token does not expire and carries no scope list: what
 * it can reach is decided by the user in Notion's own consent screen, page by page. That is the whole permission
 * model, so the connect page has to say it plainly or people wonder why Milo sees nothing.
 */

/** Pinned: the data model changed under the user's feet before (databases gained data sources), so the version is explicit. */
export const NOTION_VERSION = "2026-03-11";
const API = "https://api.notion.com/v1";

type Fetch = typeof fetch;
let http: Fetch = (input, init) => fetch(input, init);

/** Tests swap in a fake Notion. */
export function useNotionHttp(fn: Fetch | undefined): void {
  http = fn ?? ((input, init) => fetch(input, init));
}

export function notionEnabled(): boolean {
  return Boolean(config.NOTION_CLIENT_ID && config.NOTION_CLIENT_SECRET && config.SERVER_KEY_SECRET.length >= 32);
}

export function notionRedirectUri(): string | undefined {
  const base = publicBaseUrl();
  return base ? `${base}/notion/callback` : undefined;
}

export class NotionNotConnectedError extends Error {
  constructor() {
    super("Workspace Notion belum terhubung.");
    this.name = "NotionNotConnectedError";
  }
}

export class NotionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

/** The page or database was never ticked in Notion's consent screen, so as far as the token is concerned it does not exist. */
export class NotionNotSharedError extends Error {
  constructor(what = "Halaman itu") {
    super(`${what} belum dibagikan ke Milo di Notion.`);
    this.name = "NotionNotSharedError";
  }
}

export class NotionStateError extends Error {
  constructor() {
    super("Link login ini sudah dipakai atau kedaluwarsa.");
    this.name = "NotionStateError";
  }
}

export interface NotionAccount {
  userId: string;
  workspaceId: string;
  workspaceName: string | null;
  botId: string | null;
  tokenEnc: string;
  connectedAt: Date;
}

export async function getNotionAccount(userId: string): Promise<NotionAccount | undefined> {
  const [row] = await sql<NotionAccount[]>`select * from notion_accounts where user_id = ${userId}`;
  return row;
}

export async function disconnectNotion(userId: string): Promise<boolean> {
  const rows = await sql`delete from notion_accounts where user_id = ${userId} returning user_id`;
  return rows.length > 0;
}

// ---- sign-in ----------------------------------------------------------------------------------------------------

/** The state is ours, not Notion's: it ties the code that comes back to the user who started the flow. */
export async function beginNotionAuth(userId: string): Promise<string> {
  const redirect = notionRedirectUri();
  if (!redirect) throw new Error("alamat publik Milo belum diketahui, jadi Notion tidak bisa mengarahkan kembali");
  const state = randomBytes(24).toString("base64url");
  await sql`delete from oauth_states where created_at < now() - interval '1 day'`;
  await sql`
    insert into oauth_states (id, user_id, provider, services, code_verifier) values (${state}, ${userId}, 'notion', '{}', '')
  `;
  const url = new URL(`${API}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: config.NOTION_CLIENT_ID,
    response_type: "code",
    owner: "user",
    redirect_uri: redirect,
    state,
  }).toString();
  return url.toString();
}

export interface NotionAuthResult {
  userId: string;
  workspaceName: string | null;
}

interface TokenResponse {
  access_token?: string;
  workspace_id?: string;
  workspace_name?: string | null;
  bot_id?: string;
  error?: string;
  error_description?: string;
}

export async function completeNotionAuth(state: string, code: string): Promise<NotionAuthResult> {
  const [row] = await sql<{ userId: string }[]>`
    update oauth_states set used_at = now()
    where id = ${state} and provider = 'notion' and used_at is null and created_at > now() - interval '1 day'
    returning user_id
  `;
  if (!row) throw new NotionStateError();

  const redirect = notionRedirectUri();
  if (!redirect) throw new Error("alamat publik Milo belum diketahui");
  const basic = Buffer.from(`${config.NOTION_CLIENT_ID}:${config.NOTION_CLIENT_SECRET}`).toString("base64");
  const res = await http(`${API}/oauth/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/json", "Notion-Version": NOTION_VERSION },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirect }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    throw new NotionApiError(body.error_description ?? body.error ?? `HTTP ${res.status}`, res.status);
  }

  await sql`
    insert into notion_accounts (user_id, workspace_id, workspace_name, bot_id, token_enc)
    values (${row.userId}, ${body.workspace_id ?? ""}, ${body.workspace_name ?? null}, ${body.bot_id ?? null}, ${sealSecret(body.access_token)})
    on conflict (user_id) do update set
      workspace_id = excluded.workspace_id, workspace_name = excluded.workspace_name,
      bot_id = excluded.bot_id, token_enc = excluded.token_enc, connected_at = now()
  `;
  return { userId: row.userId, workspaceName: body.workspace_name ?? null };
}

// ---- calling ----------------------------------------------------------------------------------------------------

export interface NotionRequest {
  method?: string;
  path: string;
  json?: unknown;
  query?: Record<string, string | number | undefined>;
}

export async function callNotion<T>(userId: string, req: NotionRequest): Promise<T> {
  const account = await getNotionAccount(userId);
  if (!account) throw new NotionNotConnectedError();
  const url = new URL(`${API}${req.path}`);
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

  const res = await http(url, {
    method: req.method ?? "GET",
    headers: {
      authorization: `Bearer ${openSecret(account.tokenEnc)}`,
      "Notion-Version": NOTION_VERSION,
      ...(req.json === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(req.json === undefined ? {} : { body: JSON.stringify(req.json) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 204) return undefined as T;

  const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string; object?: string };
  if (!res.ok) {
    // Notion answers 404 both for "no such thing" and for "you were never given this", which to the user is the same.
    if (res.status === 404) throw new NotionNotSharedError();
    if (res.status === 401) throw new NotionNotConnectedError();
    throw new NotionApiError(body.message ?? body.code ?? `HTTP ${res.status}`, res.status);
  }
  return body as T;
}

/** Notion allows roughly three requests a second; a chat turn never needs more than a handful in a row. */
export async function politely<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = [];
  for (const task of tasks) out.push(await task());
  return out;
}
