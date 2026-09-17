import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mock, test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { billedAttempts, isDeepSeekPeak, llmCostUsd } from "../src/agent/pricing.ts";
import { parseModelWeights, pickModel, providerFor, requestExtras } from "../src/agent/providers.ts";
import { sanitizeForEcho } from "../src/agent/run.ts";
import { Debouncer } from "../src/debounce.ts";
import { looksLikeCode, normalizeCode } from "../src/onboarding/codes.ts";
import { isoInZone, normalizePhone, waMeLink } from "../src/util.ts";
import { parseWebhook } from "../src/wa/inbound.ts";
import { verifySignature } from "../src/wa/verify.ts";

test("webhook signatures are checked against the raw body", () => {
  const body = Buffer.from('{"a":1}');
  const good = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal(verifySignature(body, good, "s3cret"), true);
  assert.equal(verifySignature(body, good, "other"), false);
  assert.equal(verifySignature(Buffer.from('{"a":2}'), good, "s3cret"), false);
  assert.equal(verifySignature(body, undefined, "s3cret"), false);
  assert.equal(verifySignature(body, "sha256=zz", "s3cret"), false);
});

test("webhook payloads are normalized", () => {
  const { messages, statuses } = parseWebhook({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "6281", profile: { name: "Josh" } }],
              messages: [
                { id: "w1", from: "6281", timestamp: "1758000000", type: "text", text: { body: "halo" } },
                { id: "w2", from: "6281", timestamp: "1758000001", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "code", title: "Punya Kode" } } },
                { id: "w3", from: "6281", timestamp: "1758000002", type: "document", document: { id: "m1", filename: "a.pdf", mime_type: "application/pdf" } },
                { id: "w4", from: "6281", timestamp: "1758000003", type: "audio", audio: { id: "m2", mime_type: "audio/ogg; codecs=opus", voice: true } },
                {
                  id: "w5",
                  from: "6281",
                  timestamp: "1758000004",
                  type: "contacts",
                  contacts: [{ name: { formatted_name: "Andi" }, phones: [{ phone: "+62 812-1", wa_id: "628121" }] }],
                },
                { id: "w6", from: "6281", timestamp: "1758000005", type: "sticker", sticker: { id: "m3" } },
              ],
              statuses: [{ id: "o1", recipient_id: "6281", status: "failed", errors: [{ code: 131047, title: "Re-engagement" }] }],
            },
          },
        ],
      },
    ],
  });
  assert.equal(messages.length, 6);
  assert.equal(messages[0]?.profileName, "Josh");
  assert.deepEqual(messages[0]?.inbound, { kind: "text", text: "halo" });
  assert.deepEqual(messages[1]?.inbound, { kind: "button", id: "code", title: "Punya Kode" });
  assert.equal(messages[2]?.inbound.kind, "document");
  assert.deepEqual(messages[3]?.inbound, { kind: "audio", mediaId: "m2", mime: "audio/ogg; codecs=opus", voice: true });
  assert.deepEqual(messages[4]?.inbound, {
    kind: "contacts",
    contacts: [{ name: "Andi", phones: ["628121"], emails: [], organization: undefined }],
  });
  assert.deepEqual(messages[5]?.inbound, { kind: "unsupported", type: "sticker" });
  assert.equal(statuses[0]?.errors[0]?.code, 131047);
  assert.deepEqual(parseWebhook("nonsense"), { messages: [], statuses: [] });
});

test("phone numbers normalize to WhatsApp form", () => {
  assert.equal(normalizePhone("0812-3456-7890"), "6281234567890");
  assert.equal(normalizePhone("+62 812 3456 7890"), "6281234567890");
  assert.equal(normalizePhone("81234567890"), "6281234567890");
  assert.equal(normalizePhone("0065 9123 4567"), "6591234567");
  assert.equal(normalizePhone("123"), null);
  assert.equal(waMeLink("628123", "Halo Pak & Bu"), "https://wa.me/628123?text=Halo%20Pak%20%26%20Bu");
});

test("ISO timestamps carry the zone offset", () => {
  const d = new Date("2026-09-17T03:42:05Z");
  assert.equal(isoInZone(d, "Asia/Jakarta"), "2026-09-17T10:42:05+07:00");
  assert.equal(isoInZone(d, "Asia/Makassar"), "2026-09-17T11:42:05+08:00");
});

test("redeem codes are normalized", () => {
  assert.equal(normalizeCode("  pendiri-ab 12 "), "PENDIRI-AB12");
  assert.equal(looksLikeCode("coba-x7k2p"), true);
  assert.equal(looksLikeCode("tolong ingetin saya besok"), false);
});

test("cost uses the 1h cache write and cache read multipliers", () => {
  const cost = llmCostUsd("claude-opus-5", { input: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 });
  assert.equal(cost, 5 + 10 + 0.5 + 25);
  assert.equal(llmCostUsd("claude-sonnet-5", { input: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 0, cacheRead: 0, output: 0 }), 2 + 2.5);
  assert.equal(llmCostUsd("unknown-model", { input: 5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 5 }), 0);
});

const usage = (o: Partial<Record<string, unknown>> = {}) =>
  ({
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 40,
    cache_creation: { ephemeral_1h_input_tokens: 30, ephemeral_5m_input_tokens: 0 },
    iterations: null,
    ...o,
  }) as unknown as Anthropic.Beta.BetaUsage;

test("billed attempts skip declines that produced no output", () => {
  const plain = { model: "claude-opus-5", usage: usage() } as Anthropic.Beta.BetaMessage;
  assert.deepEqual(billedAttempts(plain), [
    { model: "claude-opus-5", usage: { input: 10, cacheWrite5m: 0, cacheWrite1h: 30, cacheRead: 40, output: 20 } },
  ]);

  const fellBack = {
    model: "claude-opus-4-8",
    usage: usage({
      iterations: [
        { type: "message", model: "claude-opus-5", input_tokens: 500, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
        { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 500, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
      ],
    }),
  } as Anthropic.Beta.BetaMessage;
  const attempts = billedAttempts(fellBack);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.model, "claude-opus-4-8");
});

test("blocks before a fallback marker are trimmed to text for echoing", () => {
  const content = [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text: "partial", citations: null },
    { type: "tool_use", id: "t1", name: "x", input: {} },
    { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-opus-4-8" } },
    { type: "thinking", thinking: "", signature: "sig2" },
    { type: "text", text: "final", citations: null },
  ] as unknown as Anthropic.Beta.BetaContentBlock[];
  assert.deepEqual(
    sanitizeForEcho(content).map((b) => b.type),
    ["text", "fallback", "thinking", "text"],
  );
  const untouched = content.slice(4);
  assert.equal(sanitizeForEcho(untouched), untouched);
});

test("debouncer coalesces bursts and never runs a key twice at once", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const d = new Debouncer(100, async (key) => {
      calls.push(key);
      if (calls.length === 1) await gate;
    });

    d.poke("u1");
    mock.timers.tick(60);
    d.poke("u1");
    mock.timers.tick(60);
    assert.equal(calls.length, 0);
    mock.timers.tick(40);
    assert.deepEqual(calls, ["u1"]);

    d.poke("u1", 10);
    mock.timers.tick(50);
    assert.deepEqual(calls, ["u1"], "no second run while the first is still going");

    release();
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(10);
    assert.deepEqual(calls, ["u1", "u1"]);
  } finally {
    mock.timers.reset();
  }
});

test("model weights parse leniently and fall back to the single default", () => {
  assert.deepEqual(parseModelWeights("claude-sonnet-5:3, deepseek-flash", "x"), [
    { model: "claude-sonnet-5", weight: 3 },
    { model: "deepseek-flash", weight: 1 },
  ]);
  assert.deepEqual(parseModelWeights("a:0, b:-1, :2", "claude-opus-5"), [{ model: "claude-opus-5", weight: 1 }]);
  assert.deepEqual(parseModelWeights("", "claude-opus-5"), [{ model: "claude-opus-5", weight: 1 }]);
});

test("model assignment is deterministic and follows the weights", () => {
  const options = [
    { model: "claude-sonnet-5", weight: 1 },
    { model: "deepseek-flash", weight: 3 },
  ];
  assert.equal(pickModel("42", options), pickModel("42", options));
  let deepseek = 0;
  for (let i = 0; i < 4000; i++) if (pickModel(String(i), options) === "deepseek-flash") deepseek++;
  const share = deepseek / 4000;
  assert.ok(share > 0.7 && share < 0.8, `share ${share}`);
  assert.equal(pickModel("1", []), null);
});

test("providers and request extras per model", () => {
  assert.equal(providerFor("deepseek-v4-pro"), "deepseek");
  assert.equal(providerFor("claude-sonnet-5"), "anthropic");
  assert.deepEqual(requestExtras("deepseek-flash"), { cacheControl: false, fallbacks: false });
  assert.deepEqual(requestExtras("claude-sonnet-5"), { cacheControl: true, fallbacks: false });
  assert.deepEqual(requestExtras("claude-opus-5"), { cacheControl: true, fallbacks: true });
});

test("DeepSeek peak hours follow the published UTC schedule", () => {
  assert.equal(isDeepSeekPeak(new Date("2026-09-17T01:00:00Z")), true, "Thu 08:00 WIB");
  assert.equal(isDeepSeekPeak(new Date("2026-09-17T03:59:59Z")), true);
  assert.equal(isDeepSeekPeak(new Date("2026-09-17T04:00:00Z")), false, "Thu 11:00 WIB");
  assert.equal(isDeepSeekPeak(new Date("2026-09-17T09:30:00Z")), true, "Thu 16:30 WIB");
  assert.equal(isDeepSeekPeak(new Date("2026-09-17T10:00:00Z")), false);
  assert.equal(isDeepSeekPeak(new Date("2026-09-19T02:00:00Z")), false, "Saturday");
  const u = { input: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1_000_000, output: 1_000_000 };
  const peak = llmCostUsd("deepseek-flash", u, new Date("2026-09-17T02:00:00Z"));
  const offPeak = llmCostUsd("deepseek-flash", u, new Date("2026-09-17T12:00:00Z"));
  assert.ok(Math.abs(peak - (0.3 + 0.006 + 1.2)) < 1e-9);
  assert.ok(Math.abs(offPeak - peak / 2) < 1e-9);
});
