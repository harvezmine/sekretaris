import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { sql, type UserRow } from "../db/index.js";
import type { Logger } from "../util.js";
import { stripInventedLinks } from "./linkGuard.js";
import { billedAttempts, llmCostUsd, priceKnown } from "./pricing.js";
import { CORE_PROMPT, turnHeader } from "./prompt.js";
import { availableModels, clientFor, pickModel, providerFor, requestExtras, type Provider } from "./providers.js";
import { appendTranscript, loadTranscript, openSession, touchSession } from "./session.js";
import { runTool, toolsFor } from "./tools.js";

type ContentBlock = Anthropic.Beta.BetaContentBlock;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export interface AgentResult {
  reply: string;
  runId: string;
  steps: number;
  costUsd: number;
}

const CACHE_1H = { type: "ephemeral", ttl: "1h" } as const;
const REFUSAL_REPLY = "Maaf, permintaan ini tidak bisa saya bantu.";
const STEP_LIMIT_NOTE =
  "Batas langkah untuk pesan ini sudah tercapai. Jangan memanggil tool lagi; jawab pengguna sekarang dengan informasi yang sudah ada, dan sebutkan singkat jika ada yang belum sempat dikerjakan.";

/**
 * After a mid-output fallback, blocks before the final fallback marker that the next model cannot use must not be
 * echoed back (thinking, tool_use without results, unknown model-internal blocks); text still carries over.
 */
export function sanitizeForEcho(content: ContentBlock[]): ContentBlock[] {
  let boundary = -1;
  content.forEach((b, i) => {
    if (b.type === "fallback") boundary = i;
  });
  if (boundary < 0) return content;
  return content.filter((b, i) => i >= boundary || b.type === "text");
}

function textAfterFallback(content: ContentBlock[]): string {
  let start = 0;
  content.forEach((b, i) => {
    if (b.type === "fallback") start = i + 1;
  });
  return content
    .slice(start)
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

export class NoModelAvailableError extends Error {
  constructor() {
    super("Tidak ada model yang bisa dipakai: isi API key untuk salah satu model di MILO_MODELS / MILO_MODEL.");
    this.name = "NoModelAvailableError";
  }
}

export interface AgentOptions {
  /** Test seam: replaces the SDK client for a provider. */
  clients?: Partial<Record<Provider, Anthropic>>;
  /** Test seam: overrides API-key detection. */
  isConfigured?: (provider: Provider) => boolean;
}

export class Agent {
  constructor(
    private readonly log: Logger,
    private readonly opts: AgentOptions = {},
  ) {
    for (const { model } of availableModels(opts.isConfigured)) {
      if (!priceKnown(model)) log.warn({ model }, "harga model tidak dikenal; biaya dicatat 0");
    }
  }

  private client(provider: Provider): Anthropic {
    return this.opts.clients?.[provider] ?? clientFor(provider);
  }

  /** Keeps each user on one model: caches and sessions are model-scoped, so switching mid-stream costs a cold start. */
  async modelFor(user: UserRow): Promise<string> {
    const options = availableModels(this.opts.isConfigured);
    if (user.llmModel && options.some((o) => o.model === user.llmModel)) return user.llmModel;
    const model = pickModel(user.id, options);
    if (!model) throw new NoModelAvailableError();
    await sql`update users set llm_model = ${model} where id = ${user.id}`;
    user.llmModel = model;
    return model;
  }

  /**
   * One bounded call outside the assistant session, for people who do not have access yet: no transcript, no
   * caching, few tools, short answer. Cost is still recorded so preboarding chatter is visible in the ledger.
   */
  async brief(
    user: UserRow,
    system: string,
    messages: MessageParam[],
    opts: { tools?: Anthropic.Beta.BetaTool[]; maxTokens?: number; kind?: string } = {},
  ): Promise<{ text: string; calls: string[]; stopReason: string | null }> {
    const model = await this.modelFor(user);
    const calledAt = new Date();
    // Thinking models spend part of max_tokens before the first visible word, so the budget is generous and the
    // effort low; a reply that still ran out (stopReason "max_tokens") is cut off and callers must not send it.
    const response = await this.client(providerFor(model)).beta.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 2000,
      system,
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
    });
    for (const attempt of billedAttempts(response, model)) {
      const cost = llmCostUsd(attempt.model, attempt.usage, calledAt);
      const u = attempt.usage;
      await sql`
        insert into usage_ledger (user_id, kind, model, input_tokens, cache_write_5m, cache_write_1h, cache_read, output_tokens, cost_usd)
        values (${user.id}, ${opts.kind ?? "preboard"}, ${attempt.model}, ${u.input}, ${u.cacheWrite5m}, ${u.cacheWrite1h}, ${u.cacheRead}, ${u.output}, ${cost})
      `;
    }
    return {
      text: response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim(),
      calls: response.content.filter((b) => b.type === "tool_use").map((b) => b.name),
      stopReason: response.stop_reason,
    };
  }

  async run(user: UserRow, turnText: string, opts: { softMode: boolean }): Promise<AgentResult> {
    const model = await this.modelFor(user);
    const provider = providerFor(model);
    const extras = requestExtras(model);
    const client = this.client(provider);
    const started = Date.now();
    const session = await openSession(user, model);
    const history = await loadTranscript(session.id);

    const note = opts.softMode ? "\n\n(Mode hemat: jawab singkat, paling banyak satu tool.)" : "";
    const userMessage: MessageParam = {
      role: "user",
      content: [{ type: "text", text: `${turnHeader(new Date(), user.timezone)}\n${turnText}${note}` }],
    };
    await appendTranscript(session.id, userMessage);
    const messages: MessageParam[] = [...history, userMessage];

    const [run] = await sql<{ id: string }[]>`
      insert into agent_runs (user_id, session_id, model, soft_mode)
      values (${user.id}, ${session.id}, ${model}, ${opts.softMode}) returning id
    `;
    const runId = run!.id;
    const maxSteps = opts.softMode ? 2 : config.MILO_MAX_STEPS;
    const cache = extras.cacheControl ? { cache_control: CACHE_1H } : {};

    let steps = 0;
    let costUsd = 0;
    let stopReason: string | null = null;
    let servedBy: string | null = null;
    const texts: string[] = [];

    try {
      while (steps < maxSteps) {
        steps++;
        const calledAt = new Date();
        const response = await client.beta.messages.create({
          model,
          max_tokens: 16000,
          system: [
            { type: "text", text: CORE_PROMPT, ...cache },
            { type: "text", text: session.snapshot, ...cache },
          ],
          tools: toolsFor(user),
          messages,
          ...cache,
          thinking: { type: "adaptive" },
          output_config: { effort: config.MILO_EFFORT },
          ...(extras.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        });

        stopReason = response.stop_reason;
        servedBy = response.model;
        for (const attempt of billedAttempts(response, model)) {
          const cost = llmCostUsd(attempt.model, attempt.usage, calledAt);
          costUsd += cost;
          const u = attempt.usage;
          await sql`
            insert into usage_ledger
              (user_id, run_id, kind, model, input_tokens, cache_write_5m, cache_write_1h, cache_read, output_tokens, cost_usd)
            values
              (${user.id}, ${runId}, 'llm', ${attempt.model}, ${u.input}, ${u.cacheWrite5m}, ${u.cacheWrite1h}, ${u.cacheRead}, ${u.output}, ${cost})
          `;
        }

        if (response.stop_reason === "refusal") {
          const replacement: MessageParam = { role: "assistant", content: [{ type: "text", text: REFUSAL_REPLY }] };
          await appendTranscript(session.id, replacement);
          texts.length = 0;
          texts.push(REFUSAL_REPLY);
          this.log.warn({ userId: user.id, category: response.stop_details?.category ?? null }, "permintaan ditolak model");
          break;
        }

        if (response.stop_reason === "max_tokens") {
          const textOnly = response.content.filter((b) => b.type === "text");
          const assistant: MessageParam = {
            role: "assistant",
            content: textOnly.length ? textOnly : [{ type: "text", text: "(jawaban terpotong)" }],
          };
          await appendTranscript(session.id, assistant);
          const text = textAfterFallback(response.content);
          if (text) texts.push(text);
          break;
        }

        const content = sanitizeForEcho(response.content);
        const assistant: MessageParam = { role: "assistant", content };
        await appendTranscript(session.id, assistant);
        messages.push(assistant);
        const text = textAfterFallback(response.content);
        if (text) texts.push(text);

        const toolUses = content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

        const results: ToolResult[] = await Promise.all(
          toolUses.map(async (tu) => {
            const outcome = await runTool({ user }, tu.name, tu.input);
            this.log.debug({ tool: tu.name, isError: outcome.isError ?? false }, "tool dijalankan");
            return {
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content: outcome.content,
              ...(outcome.isError ? { is_error: true } : {}),
            };
          }),
        );
        const toolTurn: MessageParam = {
          role: "user",
          content: steps === maxSteps - 1 ? [...results, { type: "text", text: STEP_LIMIT_NOTE }] : results,
        };
        await appendTranscript(session.id, toolTurn);
        messages.push(toolTurn);

        if (steps === maxSteps) {
          stopReason = "step_limit";
        }
      }
    } catch (err) {
      await sql`
        update agent_runs set steps = ${steps}, cost_usd = ${costUsd}, error = ${err instanceof Error ? err.message : String(err)},
          latency_ms = ${Date.now() - started}, finished_at = now()
        where id = ${runId}
      `;
      throw err;
    }

    await touchSession(session.id);
    await sql`
      update agent_runs set steps = ${steps}, stop_reason = ${stopReason}, served_by = ${servedBy},
        cost_usd = ${costUsd}, latency_ms = ${Date.now() - started}, finished_at = now()
      where id = ${runId}
    `;

    const draft =
      texts.at(-1) ||
      (stopReason === "step_limit"
        ? "Maaf, permintaan ini butuh lebih banyak langkah dari yang bisa saya kerjakan sekaligus. Coba pecah jadi beberapa permintaan."
        : "Maaf, saya belum bisa menjawab itu. Coba sampaikan dengan kalimat lain.");
    const { text: reply, removed } = stripInventedLinks(draft);
    if (removed.length) this.log.warn({ userId: user.id, runId, removed }, "model mengarang link Milo; dibuang dari balasan");
    return { reply, runId, steps, costUsd };
  }
}
