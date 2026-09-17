import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

export type Provider = "anthropic" | "deepseek";

export interface ModelWeight {
  model: string;
  weight: number;
}

export function providerFor(model: string): Provider {
  return model.startsWith("deepseek") ? "deepseek" : "anthropic";
}

export function providerConfigured(provider: Provider, env: NodeJS.ProcessEnv = process.env): boolean {
  if (provider === "deepseek") return Boolean(config.DEEPSEEK_API_KEY);
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
}

/** "claude-opus-5:1, deepseek-flash:3" → weighted list. A bare model name weighs 1. */
export function parseModelWeights(spec: string, fallback: string): ModelWeight[] {
  const entries = spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [model, weight] = part.split(":").map((x) => x.trim());
      return { model: model ?? "", weight: weight === undefined ? 1 : Number(weight) };
    })
    .filter((e) => e.model && Number.isFinite(e.weight) && e.weight > 0);
  return entries.length ? entries : [{ model: fallback, weight: 1 }];
}

/** Deterministic weighted pick, so a user lands on the same model even before the choice is stored. */
export function pickModel(userId: string, options: ModelWeight[]): string | null {
  const total = options.reduce((a, o) => a + o.weight, 0);
  if (!options.length || total <= 0) return null;
  const digest = createHash("sha256").update(`${userId}|${options.map((o) => o.model).join(",")}`).digest();
  let point = (digest.readUInt32BE(0) / 0x1_0000_0000) * total;
  for (const o of options) {
    if (point < o.weight) return o.model;
    point -= o.weight;
  }
  return options.at(-1)!.model;
}

export function availableModels(isConfigured: (p: Provider) => boolean = (p) => providerConfigured(p)): ModelWeight[] {
  return parseModelWeights(config.MILO_MODELS, config.MILO_MODEL).filter((o) => isConfigured(providerFor(o.model)));
}

const clients = new Map<Provider, Anthropic>();

export function clientFor(provider: Provider): Anthropic {
  let client = clients.get(provider);
  if (!client) {
    client =
      provider === "deepseek"
        ? new Anthropic({ apiKey: config.DEEPSEEK_API_KEY, baseURL: config.DEEPSEEK_BASE_URL, authToken: null })
        : new Anthropic();
    clients.set(provider, client);
  }
  return client;
}

/**
 * DeepSeek's Anthropic-compatible endpoint silently ignores cache_control and beta headers and caches prefixes on
 * its own, so only Claude gets explicit cache breakpoints and server-side fallbacks.
 */
export function requestExtras(model: string): {
  cacheControl: boolean;
  fallbacks: boolean;
} {
  const provider = providerFor(model);
  return {
    cacheControl: provider === "anthropic",
    fallbacks:
      provider === "anthropic" &&
      config.MILO_FALLBACKS === "default" &&
      (model.startsWith("claude-opus-5") || model.startsWith("claude-fable-5")),
  };
}
