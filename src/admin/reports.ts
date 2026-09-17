import { sql } from "../db/index.js";

export interface UsageRow {
  userId: string;
  waId: string;
  displayName: string | null;
  model: string | null;
  plan: string | null;
  status: string;
  inboundMessages: number;
  agentRuns: number;
  messagesPerRun: number | null;
  runsLight: number;
  runsMedium: number;
  runsHeavy: number;
  avgLatencyMs: number | null;
  llmCostUsd: number;
  costPerRunUsd: number | null;
  cacheReadShare: number | null;
  sttCostUsd: number;
  templateCostUsd: number;
  totalCostUsd: number;
}

/**
 * The POC's measurement report. Runs are bucketed by model calls: 1 = light (no tools), 2 = medium (one tool round),
 * 3+ = heavy. cacheReadShare is the fraction of all prompt tokens that were served from cache.
 */
export interface ModelSummary {
  model: string;
  users: number;
  agentRuns: number;
  failedRuns: number;
  avgSteps: number | null;
  shareLight: number | null;
  shareMedium: number | null;
  shareHeavy: number | null;
  avgLatencyMs: number | null;
  llmCostUsd: number;
  costPerRunUsd: number | null;
  cacheReadShare: number | null;
}

/** Side-by-side comparison of the models users were split across. */
export async function modelComparison(since: Date): Promise<ModelSummary[]> {
  const rows = await sql<Record<string, string | null>[]>`
    with runs as (
      select model,
             count(distinct user_id) as users,
             count(*) as runs,
             count(*) filter (where error is not null) as failed,
             avg(steps) as avg_steps,
             count(*) filter (where steps <= 1) as light,
             count(*) filter (where steps = 2) as medium,
             count(*) filter (where steps >= 3) as heavy,
             avg(latency_ms) as avg_latency,
             sum(cost_usd) as cost
      from agent_runs where created_at >= ${since} group by model
    ),
    tokens as (
      select r.model,
             sum(l.input_tokens) as input,
             sum(l.cache_read) as cache_read,
             sum(l.cache_write_5m + l.cache_write_1h) as cache_write
      from usage_ledger l join agent_runs r on r.id = l.run_id
      where l.kind = 'llm' and l.created_at >= ${since}
      group by r.model
    )
    select runs.*, tokens.input, tokens.cache_read, tokens.cache_write
    from runs left join tokens on tokens.model = runs.model
    order by runs.model
  `;
  const n = (v: string | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
  return rows.map((r) => {
    const runs = n(r.runs);
    const cost = n(r.cost);
    const prompt = n(r.input) + n(r.cacheRead) + n(r.cacheWrite);
    const share = (v: string | null | undefined) => (runs ? Number((n(v) / runs).toFixed(3)) : null);
    return {
      model: String(r.model),
      users: n(r.users),
      agentRuns: runs,
      failedRuns: n(r.failed),
      avgSteps: r.avgSteps === null ? null : Number(n(r.avgSteps).toFixed(2)),
      shareLight: share(r.light),
      shareMedium: share(r.medium),
      shareHeavy: share(r.heavy),
      avgLatencyMs: r.avgLatency === null ? null : Math.round(n(r.avgLatency)),
      llmCostUsd: Number(cost.toFixed(4)),
      costPerRunUsd: runs ? Number((cost / runs).toFixed(5)) : null,
      cacheReadShare: prompt ? Number((n(r.cacheRead) / prompt).toFixed(3)) : null,
    };
  });
}

export async function usageReport(
  days: number,
): Promise<{ since: Date; rows: UsageRow[]; byModel: ModelSummary[]; totals: Record<string, number> }> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await sql<Record<string, string | null>[]>`
    with runs as (
      select user_id,
             count(*) as runs,
             count(*) filter (where steps <= 1) as light,
             count(*) filter (where steps = 2) as medium,
             count(*) filter (where steps >= 3) as heavy,
             avg(latency_ms) as avg_latency,
             sum(cost_usd) as cost
      from agent_runs where created_at >= ${since} group by user_id
    ),
    llm as (
      select user_id,
             sum(input_tokens) as input,
             sum(cache_read) as cache_read,
             sum(cache_write_5m + cache_write_1h) as cache_write
      from usage_ledger where kind = 'llm' and created_at >= ${since} group by user_id
    ),
    other as (
      select user_id,
             coalesce(sum(cost_usd) filter (where kind = 'stt'), 0) as stt,
             coalesce(sum(cost_usd) filter (where kind = 'wa_template'), 0) as template
      from usage_ledger where created_at >= ${since} group by user_id
    ),
    inbound as (
      select user_id, count(*) as msgs from messages
      where direction = 'in' and created_at >= ${since} group by user_id
    )
    select u.id as user_id, u.wa_id, u.display_name, u.llm_model as model, u.plan, u.status,
           coalesce(i.msgs, 0) as inbound_messages,
           coalesce(r.runs, 0) as agent_runs,
           coalesce(r.light, 0) as runs_light,
           coalesce(r.medium, 0) as runs_medium,
           coalesce(r.heavy, 0) as runs_heavy,
           r.avg_latency as avg_latency_ms,
           coalesce(r.cost, 0) as llm_cost_usd,
           l.input, l.cache_read, l.cache_write,
           coalesce(o.stt, 0) as stt_cost_usd,
           coalesce(o.template, 0) as template_cost_usd
    from users u
    left join runs r on r.user_id = u.id
    left join llm l on l.user_id = u.id
    left join other o on o.user_id = u.id
    left join inbound i on i.user_id = u.id
    where r.runs is not null or i.msgs is not null
    order by coalesce(r.cost, 0) desc
  `;

  const n = (v: string | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
  const out: UsageRow[] = rows.map((r) => {
    const runs = n(r.agentRuns);
    const llmCost = n(r.llmCostUsd);
    const prompt = n(r.input) + n(r.cacheRead) + n(r.cacheWrite);
    const stt = n(r.sttCostUsd);
    const template = n(r.templateCostUsd);
    return {
      userId: String(r.userId),
      waId: String(r.waId),
      displayName: r.displayName ?? null,
      model: r.model ?? null,
      plan: r.plan ?? null,
      status: String(r.status),
      inboundMessages: n(r.inboundMessages),
      agentRuns: runs,
      messagesPerRun: runs ? Number((n(r.inboundMessages) / runs).toFixed(2)) : null,
      runsLight: n(r.runsLight),
      runsMedium: n(r.runsMedium),
      runsHeavy: n(r.runsHeavy),
      avgLatencyMs: r.avgLatencyMs === null ? null : Math.round(n(r.avgLatencyMs)),
      llmCostUsd: Number(llmCost.toFixed(4)),
      costPerRunUsd: runs ? Number((llmCost / runs).toFixed(4)) : null,
      cacheReadShare: prompt ? Number((n(r.cacheRead) / prompt).toFixed(3)) : null,
      sttCostUsd: Number(stt.toFixed(4)),
      templateCostUsd: Number(template.toFixed(4)),
      totalCostUsd: Number((llmCost + stt + template).toFixed(4)),
    };
  });

  const runs = out.reduce((a, r) => a + r.agentRuns, 0);
  const llm = out.reduce((a, r) => a + r.llmCostUsd, 0);
  const totals = {
    users: out.length,
    agentRuns: runs,
    llmCostUsd: Number(llm.toFixed(4)),
    costPerRunUsd: runs ? Number((llm / runs).toFixed(4)) : 0,
    shareLight: runs ? Number((out.reduce((a, r) => a + r.runsLight, 0) / runs).toFixed(3)) : 0,
    shareMedium: runs ? Number((out.reduce((a, r) => a + r.runsMedium, 0) / runs).toFixed(3)) : 0,
    shareHeavy: runs ? Number((out.reduce((a, r) => a + r.runsHeavy, 0) / runs).toFixed(3)) : 0,
    totalCostUsd: Number(out.reduce((a, r) => a + r.totalCostUsd, 0).toFixed(4)),
  };
  return { since, rows: out, byModel: await modelComparison(since), totals };
}

export async function listUsers(limit = 100) {
  return sql`
    select id, wa_id, display_name, status, plan, state, trial_ends_at, period_ends_at, last_inbound_at,
           state_data->>'executiveInterestAt' as executive_interest_at, created_at
    from users order by id desc limit ${limit}
  `;
}
