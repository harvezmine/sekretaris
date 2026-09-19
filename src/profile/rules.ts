import { sql } from "../db/index.js";

/**
 * The corrections a user gives about how the assistant should work: "jangan panjang-panjang", "jangan pakai emoji",
 * "kalau soal uang, pakai angka". They are the strongest personalisation signal there is, because the user said
 * them out loud, and until now they lived only in a session that ends.
 *
 * Kept apart from `facts`, which hold what is true about the user's world. These hold what is true about Milo.
 */

/** Few enough to stay in every prompt, and few enough that a user can read the list and disown any of them. */
export const MAX_RULES = 15;
const MAX_LENGTH = 160;

export interface UserRule {
  id: string;
  rule: string;
  createdAt: Date;
}

export async function listRules(userId: string): Promise<UserRule[]> {
  return sql<UserRule[]>`select id, rule, created_at from user_rules where user_id = ${userId} order by id`;
}

function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type RuleOutcome = { status: "added" | "replaced" | "same"; rule: string; dropped?: string };

/**
 * A new correction replaces one that says nearly the same thing, so "jawab singkat" followed later by "jawab agak
 * panjang" does not leave the model holding both. Beyond the cap the oldest goes, because the newest correction is
 * the one the user is thinking about.
 */
export async function addRule(userId: string, raw: string): Promise<RuleOutcome | undefined> {
  const rule = raw.replace(/\s+/g, " ").trim().slice(0, MAX_LENGTH);
  if (rule.length < 3) return undefined;
  const key = comparable(rule);
  const existing = await listRules(userId);

  const same = existing.find((r) => comparable(r.rule) === key);
  if (same) return { status: "same", rule: same.rule };

  // Near-duplicates: one contains the other, which is how a user restates a rule with a small change.
  const near = existing.find((r) => {
    const other = comparable(r.rule);
    return other.includes(key) || key.includes(other);
  });
  if (near) await sql`delete from user_rules where id = ${near.id}`;

  await sql`insert into user_rules (user_id, rule) values (${userId}, ${rule})`;
  const after = await listRules(userId);
  if (after.length > MAX_RULES) {
    const oldest = after.slice(0, after.length - MAX_RULES);
    await sql`delete from user_rules where id in ${sql(oldest.map((r) => r.id))}`;
  }
  return near ? { status: "replaced", rule, dropped: near.rule } : { status: "added", rule };
}

/** Removes the rule the user means by roughly quoting it back. */
export async function forgetRule(userId: string, text: string): Promise<UserRule | undefined> {
  const key = comparable(text);
  if (!key) return undefined;
  const rules = await listRules(userId);
  const hit =
    rules.find((r) => comparable(r.rule) === key) ??
    rules.find((r) => comparable(r.rule).includes(key)) ??
    rules.find((r) => key.includes(comparable(r.rule)));
  if (!hit) return undefined;
  await sql`delete from user_rules where id = ${hit.id}`;
  return hit;
}
