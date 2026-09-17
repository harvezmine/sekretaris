import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkText, toWhatsApp } from "../src/wa/format.ts";

test("WhatsApp formatting written by the model passes through untouched", () => {
  const wa = "✅ *Profesional* aktif sampai _17 Oktober_ ~bukan~ lagi.";
  assert.equal(toWhatsApp(wa), wa);
});

test("bold, strike and headings become WhatsApp formatting", () => {
  assert.equal(toWhatsApp("**Rapat** jam *3*"), "*Rapat* jam *3*");
  assert.equal(toWhatsApp("## **Ringkasan** Proposal"), "*Ringkasan Proposal*");
  assert.equal(toWhatsApp("__tebal__ dan ~~batal~~"), "*tebal* dan ~batal~");
});

test("bullets are normalized and not mistaken for italics", () => {
  assert.equal(toWhatsApp("- satu\n* dua\n+ tiga"), "• satu\n• dua\n• tiga");
  assert.equal(toWhatsApp("* **Harga**: Rp500.000"), "• *Harga*: Rp500.000");
});

test("links, rules and tables are flattened", () => {
  assert.equal(toWhatsApp("[Buka](https://milo.id/a)"), "Buka (https://milo.id/a)");
  assert.equal(toWhatsApp("[https://x.id](https://x.id)"), "https://x.id");
  assert.equal(toWhatsApp("atas\n\n---\n\nbawah"), "atas\n\nbawah");
  assert.equal(toWhatsApp("| A | B |\n|---|---|\n| 1 | 2 |"), "A — B\n1 — 2");
});

test("code is left untouched", () => {
  const input = "Jalankan `a*b*c` lalu\n```js\nconst x = **y**;\n```";
  const out = toWhatsApp(input);
  assert.ok(out.includes("`a*b*c`"));
  assert.ok(out.includes("const x = **y**;"));
});

test("chunking respects the limit and prefers paragraph boundaries", () => {
  const para = "Kalimat pendek. ".repeat(20).trim();
  const text = Array.from({ length: 10 }, () => para).join("\n\n");
  const chunks = chunkText(text, 1000);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1000);
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
  assert.deepEqual(chunkText("x".repeat(25), 10), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
});
