import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { sql } from "../db/index.js";
import { openSecret, sealSecret } from "../servers/keys.js";
import { publicBaseUrl } from "../uploads/links.js";

/**
 * Google OAuth for one WhatsApp user at a time. Tokens are sealed with SERVER_KEY_SECRET and never reach the model;
 * every API call goes through callGoogle, which refreshes the access token and marks the account expired when
 * Google refuses the refresh token (weekly in Testing mode).
 */

export type GoogleService = "calendar" | "gmail" | "drive" | "contacts" | "tasks" | "forms";
export const ALL_SERVICES: readonly GoogleService[] = ["calendar", "gmail", "drive", "contacts", "tasks", "forms"];

export const SCOPE = {
  calendar: "https://www.googleapis.com/auth/calendar.events",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  driveFile: "https://www.googleapis.com/auth/drive.file",
  driveRead: "https://www.googleapis.com/auth/drive.readonly",
  contacts: "https://www.googleapis.com/auth/contacts.readonly",
  tasks: "https://www.googleapis.com/auth/tasks",
  formsBody: "https://www.googleapis.com/auth/forms.body",
  formsResponses: "https://www.googleapis.com/auth/forms.responses.readonly",
} as const;

export const ENDPOINTS = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  calendar: "https://www.googleapis.com/calendar/v3",
  gmail: "https://gmail.googleapis.com/gmail/v1",
  drive: "https://www.googleapis.com/drive/v3",
  people: "https://people.googleapis.com/v1",
  sheets: "https://sheets.googleapis.com/v4",
  driveUpload: "https://www.googleapis.com/upload/drive/v3",
  tasks: "https://tasks.googleapis.com/tasks/v1",
  forms: "https://forms.googleapis.com/v1",
} as const;

export const SERVICE_LABEL: Record<GoogleService, string> = {
  calendar: "Google Kalender",
  gmail: "Gmail",
  drive: "Google Drive",
  contacts: "Google Kontak",
  tasks: "Google Tasks",
  forms: "Google Formulir",
};

type Fetch = typeof fetch;
let http: Fetch = (input, init) => fetch(input, init);

/**
 * The account a single tool call is working with. Request-scoped rather than passed down, because otherwise every
 * function between the tool and the HTTP call would carry an address it does not care about.
 */
const accountScope = new AsyncLocalStorage<string>();

export function withAccount<T>(email: string | undefined, run: () => Promise<T>): Promise<T> {
  return email ? accountScope.run(email, run) : run();
}

export function currentAccountEmail(): string | undefined {
  return accountScope.getStore();
}

/** Tests swap in a fake Google. */
export function useGoogleHttp(fn: Fetch | undefined): void {
  http = fn ?? ((input, init) => fetch(input, init));
}

export function enabledServices(): GoogleService[] {
  const wanted = new Set(config.GOOGLE_SERVICES.split(",").map((s) => s.trim().toLowerCase()));
  return ALL_SERVICES.filter((s) => wanted.has(s));
}

export function googleEnabled(): boolean {
  return Boolean(
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.SERVER_KEY_SECRET.length >= 32 && enabledServices().length,
  );
}

export function scopesFor(service: GoogleService): string[] {
  switch (service) {
    case "calendar":
      return [SCOPE.calendar];
    case "gmail":
      return [SCOPE.gmailSend, ...(config.GOOGLE_GMAIL_READ ? [SCOPE.gmailRead] : [])];
    case "drive":
      return [SCOPE.driveFile, ...(config.GOOGLE_DRIVE_FULL ? [SCOPE.driveRead] : [])];
    case "contacts":
      return [SCOPE.contacts];
    case "tasks":
      return [SCOPE.tasks];
    // Drive comes along because publishing a form and sharing its link are Drive operations.
    case "forms":
      return [SCOPE.formsBody, SCOPE.formsResponses, SCOPE.driveFile];
  }
}

export function servicesGranted(scopes: readonly string[]): GoogleService[] {
  return enabledServices().filter((s) => scopesFor(s).every((scope) => scopes.includes(scope)));
}

export function redirectUri(): string | undefined {
  if (config.GOOGLE_REDIRECT_URL) return config.GOOGLE_REDIRECT_URL;
  const base = publicBaseUrl();
  return base ? `${base}/google/callback` : undefined;
}

export class GoogleNotConnectedError extends Error {
  constructor(readonly scopes: readonly string[]) {
    super("Akun Google untuk fitur ini belum terhubung.");
    this.name = "GoogleNotConnectedError";
  }
}

/** The user has to sign in again. */
export class GoogleAuthError extends Error {
  constructor(message = "Login Google sudah kedaluwarsa.") {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export class OAuthStateError extends Error {
  constructor() {
    super("Link login ini sudah dipakai atau kedaluwarsa.");
    this.name = "OAuthStateError";
  }
}

export interface GoogleAccount {
  userId: string;
  email: string;
  scopes: string[];
  refreshTokenEnc: string | null;
  accessTokenEnc: string | null;
  accessExpiresAt: Date | null;
  status: "active" | "expired";
  lastError: string | null;
  expiredNotifiedAt: Date | null;
  connectedAt: Date;
  /** What the user calls it: "kantor", "pribadi". Guessed from the address until they rename it. */
  label: string | null;
  isPrimary: boolean;
}

/**
 * A user may connect several Google accounts, typically a personal one and a work one. Everything defaults to the
 * primary; a caller that knows which account it wants passes the address, and a turn can set one for its duration
 * with withAccount, so the twenty-odd places that call Google do not each have to carry it.
 */
export async function listAccounts(userId: string): Promise<GoogleAccount[]> {
  return sql<GoogleAccount[]>`select * from google_accounts where user_id = ${userId} order by is_primary desc, connected_at`;
}

export async function getAccount(userId: string, email?: string): Promise<GoogleAccount | undefined> {
  const wanted = email ?? currentAccountEmail();
  if (wanted) {
    const [row] = await sql<GoogleAccount[]>`select * from google_accounts where user_id = ${userId} and lower(email) = lower(${wanted})`;
    return row;
  }
  const accounts = await listAccounts(userId);
  return accounts.find((a) => a.isPrimary) ?? accounts[0];
}

/** Consumer mail is personal, a company domain is work; the user renames it whenever the guess is wrong. */
export function guessLabel(email: string): string {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (/^(gmail|googlemail|yahoo|outlook|hotmail|icloud|proton|protonmail)\./.test(`${domain}.`)) return "pribadi";
  const name = domain.split(".")[0];
  return name ? name.slice(0, 30) : "kerja";
}

/** What to call an account in a sentence: the user's own name for it, or the guess until they give it one. */
export function accountName(account: Pick<GoogleAccount, "email" | "label">): string {
  return account.label?.trim() || guessLabel(account.email);
}

/**
 * What the user meant by "email kerja saya" or "yang @ptkarya.co.id": their label or their address, matched
 * loosely. Nothing matching means nothing is guessed; the caller says which accounts exist instead.
 */
export async function resolveAccount(userId: string, hint?: string): Promise<{ account?: GoogleAccount; accounts: GoogleAccount[] }> {
  const accounts = await listAccounts(userId);
  if (!hint?.trim()) return { account: accounts.find((a) => a.isPrimary) ?? accounts[0], accounts };
  const wanted = hint.trim().toLowerCase();
  // Matched against the name the user sees, which for an account connected before naming existed is the guess.
  const named = (a: GoogleAccount) => accountName(a).toLowerCase();
  const account =
    accounts.find((a) => a.email.toLowerCase() === wanted) ??
    accounts.find((a) => named(a) === wanted) ??
    accounts.find((a) => a.email.toLowerCase().includes(wanted) || wanted.includes(a.email.toLowerCase())) ??
    accounts.find((a) => wanted.includes(named(a)) || named(a).includes(wanted));
  return { ...(account ? { account } : {}), accounts };
}

export async function renameAccount(userId: string, email: string, label: string): Promise<boolean> {
  const rows = await sql`
    update google_accounts set label = ${label.trim().slice(0, 30)}, updated_at = now()
    where user_id = ${userId} and lower(email) = lower(${email}) returning email
  `;
  return rows.length > 0;
}

export async function setPrimaryAccount(userId: string, email: string): Promise<boolean> {
  const [exists] = await sql`select 1 from google_accounts where user_id = ${userId} and lower(email) = lower(${email})`;
  if (!exists) return false;
  await sql`update google_accounts set is_primary = false where user_id = ${userId} and is_primary`;
  await sql`update google_accounts set is_primary = true, updated_at = now() where user_id = ${userId} and lower(email) = lower(${email})`;
  return true;
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const json = JSON.parse(body) as { error?: string | { message?: string }; error_description?: string };
    if (typeof json.error === "object") return json.error.message ?? body.slice(0, 200);
    return json.error_description ?? json.error ?? body.slice(0, 200);
  } catch {
    return body.slice(0, 200) || `HTTP ${res.status}`;
  }
}

async function tokenRequest(params: Record<string, string>): Promise<Response> {
  return http(ENDPOINTS.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID, client_secret: config.GOOGLE_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
}

// ---- sign-in ---------------------------------------------------------------------------------------------------------

export async function beginAuth(userId: string, services: readonly GoogleService[]): Promise<string> {
  const redirect = redirectUri();
  if (!redirect) throw new Error("alamat publik Milo belum diketahui, jadi Google tidak bisa mengarahkan kembali");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  await sql`delete from oauth_states where created_at < now() - interval '1 day'`;
  await sql`
    insert into oauth_states (id, user_id, services, code_verifier) values (${state}, ${userId}, ${services as string[]}, ${verifier})
  `;
  // Services can share a scope (a form is published through Drive), and Google should be asked for each one once.
  const scopes = [...new Set(["openid", "email", ...services.flatMap(scopesFor)])];
  const url = new URL(ENDPOINTS.auth);
  url.search = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirect,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    // The chooser matters once a second account is possible: without it Google silently takes whoever is signed in.
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string };
    return claims.email ?? null;
  } catch {
    return null;
  }
}

export interface AuthResult {
  userId: string;
  email: string;
  requested: GoogleService[];
  granted: GoogleService[];
  /** False when this address was already connected and has just been signed in again. */
  added: boolean;
  /** How many accounts the user has now, so the reply can mention the others. */
  accounts: number;
  /** The name of the account that stays the default, which is not always the one just connected. */
  primary: string;
}

/**
 * The id_token comes straight from Google's token endpoint over TLS, so its claims are read without verifying the
 * signature; it is only used to show the user which account they connected.
 */
export async function completeAuth(stateId: string, code: string): Promise<AuthResult> {
  const [state] = await sql<{ userId: string; services: GoogleService[]; codeVerifier: string }[]>`
    update oauth_states set used_at = now()
    where id = ${stateId} and used_at is null and created_at > now() - interval '30 minutes'
    returning user_id, services, code_verifier
  `;
  if (!state) throw new OAuthStateError();
  const res = await tokenRequest({
    code,
    redirect_uri: redirectUri() ?? "",
    grant_type: "authorization_code",
    code_verifier: state.codeVerifier,
  });
  if (!res.ok) throw new GoogleApiError(`Google menolak kode login: ${await errorText(res)}`, res.status);
  const json = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    id_token?: string;
  };
  // Which account this is has to be known before anything is kept, or a missing refresh token would be filled in
  // from whichever account happened to be the primary.
  const email = emailFromIdToken(json.id_token);
  if (!email) throw new GoogleApiError("Google tidak memberitahukan alamat email akun ini.", 400);
  const before = await listAccounts(state.userId);
  const existing = before.find((a) => a.email.toLowerCase() === email.toLowerCase());
  const refreshEnc = json.refresh_token ? sealSecret(json.refresh_token) : existing?.refreshTokenEnc;
  if (!refreshEnc) throw new GoogleApiError("Google tidak memberikan akses jangka panjang. Coba hubungkan ulang.", 400);
  const scopes = (json.scope ?? "").split(" ").filter(Boolean);
  const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000);
  // The first account signed in is the primary; a second one joins it rather than pushing it out.
  const firstOne = before.length === 0;
  await sql`
    insert into google_accounts (user_id, email, scopes, refresh_token_enc, access_token_enc, access_expires_at, status, label, is_primary)
    values (${state.userId}, ${email}, ${scopes}, ${refreshEnc}, ${sealSecret(json.access_token)}, ${expiresAt}, 'active', ${guessLabel(email)}, ${firstOne})
    on conflict (user_id, email) do update set
      scopes = excluded.scopes, refresh_token_enc = coalesce(excluded.refresh_token_enc, google_accounts.refresh_token_enc),
      access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at,
      status = 'active', last_error = null, expired_notified_at = null, updated_at = now()
  `;
  const after = await listAccounts(state.userId);
  return {
    userId: state.userId,
    email,
    requested: state.services,
    granted: servicesGranted(scopes),
    added: !existing,
    accounts: after.length,
    primary: after.find((a) => a.isPrimary)?.email ?? email,
  };
}

/** Revokes at Google (best effort) and forgets the tokens. */
async function revokeAt(account: GoogleAccount): Promise<void> {
  const token = account.refreshTokenEnc ? openSecret(account.refreshTokenEnc) : undefined;
  if (!token) return;
  await http(`${ENDPOINTS.revoke}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

/** One account when an address is given, otherwise every account the user connected. */
export async function disconnect(userId: string, email?: string): Promise<GoogleAccount[]> {
  const accounts = await listAccounts(userId);
  const going = email ? accounts.filter((a) => a.email.toLowerCase() === email.toLowerCase()) : accounts;
  if (!going.length) return [];
  for (const account of going) await revokeAt(account);
  await sql`delete from google_accounts where user_id = ${userId} and email in ${sql(going.map((a) => a.email))}`;
  // Removing the primary leaves the rest headless, so the oldest of them takes over.
  const left = accounts.filter((a) => !going.some((g) => g.email === a.email));
  if (left.length && !left.some((a) => a.isPrimary)) {
    await setPrimaryAccount(userId, left[0]!.email);
  }
  return going;
}

async function markExpired(userId: string, email: string, reason: string): Promise<void> {
  await sql`
    update google_accounts set status = 'expired', last_error = ${reason.slice(0, 300)}, access_token_enc = null, updated_at = now()
    where user_id = ${userId} and email = ${email}
  `;
}

// ---- API calls -------------------------------------------------------------------------------------------------------

async function accessToken(account: GoogleAccount, force = false): Promise<string> {
  if (!force && account.accessTokenEnc && account.accessExpiresAt && account.accessExpiresAt.getTime() > Date.now() + 60_000) {
    return openSecret(account.accessTokenEnc);
  }
  if (!account.refreshTokenEnc) throw new GoogleAuthError();
  const res = await tokenRequest({ refresh_token: openSecret(account.refreshTokenEnc), grant_type: "refresh_token" });
  if (!res.ok) {
    const reason = await errorText(res);
    if (res.status === 400 || res.status === 401) {
      await markExpired(account.userId, account.email, reason);
      throw new GoogleAuthError();
    }
    throw new GoogleApiError(`Google tidak bisa dihubungi: ${reason}`, res.status);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number; scope?: string };
  const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000);
  const scopes = json.scope ? json.scope.split(" ").filter(Boolean) : account.scopes;
  await sql`
    update google_accounts set access_token_enc = ${sealSecret(json.access_token)}, access_expires_at = ${expiresAt},
      scopes = ${scopes}, updated_at = now()
    where user_id = ${account.userId} and email = ${account.email}
  `;
  account.scopes = scopes;
  return json.access_token;
}

/** The account, if it is active and has at least one of `anyOf`. */
export async function requireScope(userId: string, anyOf: readonly string[], email?: string): Promise<GoogleAccount> {
  const account = await getAccount(userId, email);
  if (!account || !anyOf.some((s) => account.scopes.includes(s))) throw new GoogleNotConnectedError(anyOf);
  if (account.status !== "active") throw new GoogleAuthError();
  return account;
}

export interface GoogleRequest {
  method?: string;
  url: string;
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

async function send(userId: string, anyOf: readonly string[], req: GoogleRequest): Promise<Response> {
  const account = await requireScope(userId, anyOf);
  const url = new URL(req.url);
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const attempt = async (force: boolean) =>
    http(url, {
      method: req.method ?? "GET",
      headers: {
        authorization: `Bearer ${await accessToken(account, force)}`,
        ...(req.json !== undefined ? { "content-type": "application/json" } : {}),
        ...req.headers,
      },
      ...(req.json !== undefined ? { body: JSON.stringify(req.json) } : req.body !== undefined ? { body: req.body } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  let res = await attempt(false);
  if (res.status === 401) res = await attempt(true);
  if (res.status === 401) {
    await markExpired(userId, account.email, await errorText(res));
    throw new GoogleAuthError();
  }
  if (!res.ok) {
    const message = await errorText(res);
    if (res.status === 403 && /insufficient/i.test(message)) throw new GoogleNotConnectedError(anyOf);
    throw new GoogleApiError(message, res.status);
  }
  return res;
}

export async function callGoogle<T>(userId: string, anyOf: readonly string[], req: GoogleRequest): Promise<T> {
  const res = await send(userId, anyOf, req);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function downloadGoogle(
  userId: string,
  anyOf: readonly string[],
  req: GoogleRequest,
  maxBytes: number,
): Promise<{ data: Buffer; mimeType: string }> {
  const res = await send(userId, anyOf, req);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new GoogleApiError(`file terlalu besar (${Math.round(length / 1_048_576)} MB)`, 413);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) throw new GoogleApiError(`file terlalu besar (${Math.round(data.length / 1_048_576)} MB)`, 413);
  return { data, mimeType: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream" };
}

/** What a connected account can do, for the model's profile block and the connections menu. */
export function describeAccess(account: Pick<GoogleAccount, "scopes">): string[] {
  const has = (s: string) => account.scopes.includes(s);
  const out: string[] = [];
  if (has(SCOPE.calendar)) out.push("calendar (read and edit events)");
  if (has(SCOPE.gmailRead) || has(SCOPE.gmailSend)) {
    out.push(`gmail (${[has(SCOPE.gmailRead) ? "search and read" : "", has(SCOPE.gmailSend) ? "send after confirmation" : ""].filter(Boolean).join(", ")})`);
  }
  if (has(SCOPE.driveRead) || has(SCOPE.driveFile)) {
    out.push(`drive (${has(SCOPE.driveRead) ? "search and read all files" : "only files Milo created"}${has(SCOPE.driveFile) ? ", save files" : ""})`);
  }
  if (has(SCOPE.contacts)) out.push("contacts (look up the user's own Google contacts)");
  if (has(SCOPE.tasks)) out.push("tasks (read, add and tick off their Google Tasks; a task keeps a date, never a time)");
  if (has(SCOPE.formsBody)) out.push("forms (create a Google Form anyone can answer, and read what came in)");
  return out;
}
