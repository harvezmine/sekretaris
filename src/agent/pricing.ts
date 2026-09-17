import type Anthropic from "@anthropic-ai/sdk";

interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Claude list prices, USD per million tokens. Cache reads bill at 0.1x input, writes at 1.25x (5m) or 2x (1h). */
function claude(input: number, output: number, cacheReadMultiplier = 0.1): Rate {
  return { input, output, cacheRead: input * cacheReadMultiplier, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 };
}

/** DeepSeek has no cache-write surcharge; a cache miss bills as plain input. */
function deepseek(cacheHit: number, cacheMiss: number, output: number): Rate {
  return { input: cacheMiss, output, cacheRead: cacheHit, cacheWrite5m: cacheMiss, cacheWrite1h: cacheMiss };
}

const CLAUDE: Record<string, Rate> = {
  "claude-fable-5-1": claude(10, 50, 0.025),
  "claude-fable-5": claude(10, 50),
  "claude-opus-5": claude(5, 25),
  "claude-opus-4-8": claude(5, 25),
  "claude-sonnet-5": claude(2, 10),
  "claude-haiku-4-5": claude(1, 5),
};

/** Peak rates; off-peak is exactly half. */
const DEEPSEEK_PEAK: Record<string, Rate> = {
  "deepseek-flash": deepseek(0.006, 0.3, 1.2),
  "deepseek-v4-pro": deepseek(0.044, 1.32, 3.96),
};

/** DeepSeek peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday (08–11 and 13–17 WIB). */
export function isDeepSeekPeak(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = at.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

function rateFor(model: string, at: Date): Rate | undefined {
  const peak = DEEPSEEK_PEAK[model];
  if (peak) {
    if (isDeepSeekPeak(at)) return peak;
    return {
      input: peak.input / 2,
      output: peak.output / 2,
      cacheRead: peak.cacheRead / 2,
      cacheWrite5m: peak.cacheWrite5m / 2,
      cacheWrite1h: peak.cacheWrite1h / 2,
    };
  }
  return CLAUDE[model];
}

export interface TokenUsage {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

interface ApiUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } | null;
}

export function priceKnown(model: string): boolean {
  return model in CLAUDE || model in DEEPSEEK_PEAK;
}

export function toTokenUsage(u: ApiUsageLike): TokenUsage {
  const created = u.cache_creation_input_tokens ?? 0;
  const oneHour = u.cache_creation ? u.cache_creation.ephemeral_1h_input_tokens : created;
  const fiveMin = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens : 0;
  return {
    input: u.input_tokens,
    cacheWrite5m: fiveMin,
    cacheWrite1h: oneHour,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens,
  };
}

export function llmCostUsd(model: string, u: TokenUsage, at: Date = new Date()): number {
  const r = rateFor(model, at);
  if (!r) return 0;
  return (
    (u.input * r.input +
      u.cacheWrite5m * r.cacheWrite5m +
      u.cacheWrite1h * r.cacheWrite1h +
      u.cacheRead * r.cacheRead +
      u.output * r.output) /
    1_000_000
  );
}

/**
 * Splits a response into the attempts that were actually billed. Top-level usage covers only the attempt that
 * produced the message; when a server-side fallback ran, usage.iterations holds every attempt, and an attempt
 * declined before producing output is reported there but not billed.
 */
export function billedAttempts(
  message: Anthropic.Beta.BetaMessage,
  requestedModel: string = message.model,
): { model: string; usage: TokenUsage }[] {
  const iterations = message.usage.iterations ?? [];
  if (!iterations.some((i) => i.type === "fallback_message")) {
    const model = priceKnown(message.model) ? message.model : requestedModel;
    return [{ model, usage: toTokenUsage(message.usage) }];
  }
  const attempts: { model: string; usage: TokenUsage }[] = [];
  for (const it of iterations) {
    if (it.type === "fallback_message") attempts.push({ model: it.model, usage: toTokenUsage(it) });
    else if (it.type === "message" && it.output_tokens > 0) attempts.push({ model: it.model ?? message.model, usage: toTokenUsage(it) });
  }
  return attempts;
}
