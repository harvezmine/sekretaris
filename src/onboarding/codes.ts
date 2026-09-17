import { randomInt } from "node:crypto";
import { sql } from "../db/index.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type CodeKind = "trial" | "pendiri";

export interface RedeemCode {
  code: string;
  kind: CodeKind;
  trialDays: number | null;
  maxUses: number;
  usedCount: number;
  expiresAt: Date | null;
  source: string | null;
}

export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}

/** A cheap pre-check before a database lookup: one token, letters, digits and dashes. */
export function looksLikeCode(input: string): boolean {
  return /^[A-Z0-9][A-Z0-9-]{3,31}$/.test(input.trim().toUpperCase());
}

export function generateCode(prefix: string, length = 5): string {
  let body = "";
  for (let i = 0; i < length; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix.toUpperCase()}-${body}`;
}

export async function createCodes(opts: {
  kind: CodeKind;
  count: number;
  maxUses: number;
  trialDays?: number;
  expiresInDays?: number;
  source?: string;
  prefix?: string;
}): Promise<RedeemCode[]> {
  const prefix = opts.prefix ?? (opts.kind === "pendiri" ? "PENDIRI" : "COBA");
  const expiresAt = opts.expiresInDays ? new Date(Date.now() + opts.expiresInDays * 86_400_000) : null;
  const created: RedeemCode[] = [];
  while (created.length < opts.count) {
    const code = generateCode(prefix);
    const rows = await sql<RedeemCode[]>`
      insert into redeem_codes (code, kind, trial_days, max_uses, expires_at, source)
      values (${code}, ${opts.kind}, ${opts.kind === "trial" ? (opts.trialDays ?? null) : null}, ${opts.maxUses}, ${expiresAt}, ${opts.source ?? null})
      on conflict (code) do nothing
      returning *
    `;
    if (rows[0]) created.push(rows[0]);
  }
  return created;
}

export async function findCode(input: string): Promise<RedeemCode | undefined> {
  const [row] = await sql<RedeemCode[]>`select * from redeem_codes where code = ${normalizeCode(input)}`;
  return row;
}

export type RedeemResult = { ok: true; code: RedeemCode } | { ok: false; reason: "unknown" | "expired" | "used_up" };

/** Binds a code to one user. Re-entering a code the same user already redeemed succeeds without using another slot. */
export async function redeem(userId: string, input: string): Promise<RedeemResult> {
  const code = normalizeCode(input);
  return sql.begin(async (tx) => {
    const [row] = await tx<RedeemCode[]>`select * from redeem_codes where code = ${code} for update`;
    if (!row) return { ok: false, reason: "unknown" } as const;
    const [already] = await tx`select 1 from redemptions where code = ${code} and user_id = ${userId}`;
    if (already) return { ok: true, code: row } as const;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" } as const;
    if (row.usedCount >= row.maxUses) return { ok: false, reason: "used_up" } as const;
    await tx`insert into redemptions (code, user_id) values (${code}, ${userId})`;
    await tx`update redeem_codes set used_count = used_count + 1 where code = ${code}`;
    return { ok: true, code: { ...row, usedCount: row.usedCount + 1 } } as const;
  });
}

export async function hasPendiriRedemption(userId: string): Promise<boolean> {
  const [row] = await sql`
    select 1 from redemptions r join redeem_codes c on c.code = r.code
    where r.user_id = ${userId} and c.kind = 'pendiri' limit 1
  `;
  return Boolean(row);
}
