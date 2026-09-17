import postgres from "postgres";
import { config } from "../config.js";
import { SCHEMA_SQL } from "./schema.js";

export const sql = postgres(config.DATABASE_URL, {
  max: 10,
  onnotice: () => {},
  transform: { column: { from: postgres.toCamel } },
});

export type Sql = typeof sql;

export async function migrate(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(4242001)`;
    await tx.unsafe(SCHEMA_SQL);
  });
}

export interface UserRow {
  id: string;
  waId: string;
  displayName: string | null;
  timezone: string;
  status: "new" | "trialing" | "active" | "expired" | "opted_out" | "blocked";
  plan: "trial" | "pendiri" | "profesional" | "eksekutif" | null;
  state: string;
  stateData: Record<string, unknown>;
  consentAt: Date | null;
  trialEndsAt: Date | null;
  periodEndsAt: Date | null;
  lastInboundAt: Date | null;
  llmModel: string | null;
  assistantName: string | null;
  persona: string | null;
  createdAt: Date;
}

export async function getUser(id: string): Promise<UserRow | undefined> {
  const [row] = await sql<UserRow[]>`select * from users where id = ${id}`;
  return row;
}

export async function updateUser(
  id: string,
  patch: Partial<{
    status: UserRow["status"];
    plan: UserRow["plan"];
    state: string;
    stateData: Record<string, unknown>;
    consentAt: Date;
    trialEndsAt: Date;
    periodEndsAt: Date;
    displayName: string;
  }>,
): Promise<UserRow> {
  const columns: Record<string, unknown> = {};
  if (patch.status !== undefined) columns.status = patch.status;
  if (patch.plan !== undefined) columns.plan = patch.plan;
  if (patch.state !== undefined) columns.state = patch.state;
  if (patch.stateData !== undefined) columns.state_data = sql.json(patch.stateData as postgres.JSONValue);
  if (patch.consentAt !== undefined) columns.consent_at = patch.consentAt;
  if (patch.trialEndsAt !== undefined) columns.trial_ends_at = patch.trialEndsAt;
  if (patch.periodEndsAt !== undefined) columns.period_ends_at = patch.periodEndsAt;
  if (patch.displayName !== undefined) columns.display_name = patch.displayName;
  columns.updated_at = new Date();
  const [row] = await sql<UserRow[]>`update users set ${sql(columns)} where id = ${id} returning *`;
  if (!row) throw new Error(`user ${id} tidak ditemukan`);
  return row;
}
