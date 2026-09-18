import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { InstanPayProvider, instanPaySignature } from "../src/payments/instanpay.ts";
import { paymentCaption, type PaymentRow } from "../src/payments/service.ts";
import { WhatsAppError } from "../src/wa/client.ts";
import { FonnteClient, fonnteFieldsPresent, parseFonnteWebhook, parsePoint, parseVCards } from "../src/wa/fonnte.ts";
import { matchMenuReply, renderMenu } from "../src/wa/menu.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: ((call: Call) => Response)[]) {
  const calls: Call[] = [];
  const http = (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error("tidak ada respons tiruan lagi");
    return next(call);
  }) as typeof fetch;
  return { http, calls };
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const buttons = [
  { id: "code", title: "Punya Kode" },
  { id: "price", title: "Lihat Harga" },
  { id: "faq", title: "Tanya Dulu" },
];

test("menus render as numbered text and replies map back to buttons", () => {
  const text = renderMenu("Pilih:", buttons);
  assert.equal(text, "Pilih:\n\nBalas dengan angka:\n*1.* Punya Kode\n*2.* Lihat Harga\n*3.* Tanya Dulu");
  assert.equal(matchMenuReply("2", buttons)?.id, "price");
  assert.equal(matchMenuReply(" (3) ", buttons)?.id, "faq");
  assert.equal(matchMenuReply("1.", buttons)?.id, "code");
  assert.equal(matchMenuReply("lihat harga", buttons)?.id, "price");
  assert.equal(matchMenuReply("4", buttons), undefined);
  assert.equal(matchMenuReply("2 orang", buttons), undefined);
});

test("Fonnte sends form data with the device token and numbered menus", async () => {
  const { http, calls } = fakeFetch([
    json({ status: true, id: ["801"], detail: "success! message in queue" }),
    json({ status: true, id: ["802"] }),
  ]);
  const wa = new FonnteClient({ token: "dev-token", typing: true }, http);
  assert.equal(await wa.sendText("6281234", "halo"), "fonnte.out.801");
  const first = calls[0]!;
  assert.equal(first.url, "https://api.fonnte.com/send");
  assert.equal((first.init.headers as Record<string, string>).Authorization, "dev-token");
  const form = first.init.body as FormData;
  assert.equal(form.get("target"), "6281234");
  assert.equal(form.get("message"), "halo");
  assert.equal(form.get("countryCode"), "0");
  assert.equal(form.get("typing"), "true");

  await wa.sendButtons("6281234", "Pilih:", buttons);
  assert.match(String((calls[1]!.init.body as FormData).get("message")), /\*2\.\* Lihat Harga/);
  assert.equal(wa.supportsButtons, false);
  assert.equal(wa.serviceWindow, false);
});

test("Fonnte failures raise, and a refused image falls back to its caption", async () => {
  const { http, calls } = fakeFetch([
    json({ status: false, reason: "token invalid" }),
    json({ status: false, reason: "file format not supported" }),
    json({ status: true, id: ["9"] }),
  ]);
  const wa = new FonnteClient({ token: "t", typing: false }, http);
  await assert.rejects(wa.sendText("62", "x"), (err: unknown) => err instanceof WhatsAppError && /token invalid/.test(err.message));
  assert.equal(await wa.sendImage("62", Buffer.from("png"), "Bayar di https://pay.example/x"), "fonnte.out.9");
  assert.ok((calls[1]!.init.body as FormData).get("file"), "first attempt uploads the image");
  const fallback = String((calls[2]!.init.body as FormData).get("message"));
  assert.match(fallback, /https:\/\/pay\.example\/x/);
  assert.match(fallback, /Gambar tidak bisa dikirim/);
});

test("Fonnte webhooks are normalized; group messages are ignored", () => {
  const [text] = parseFonnteWebhook({ device: "d", sender: "6281234", name: "Josh", message: "halo", timestamp: 1758000000 });
  assert.equal(text!.from, "6281234");
  assert.equal(text!.profileName, "Josh");
  assert.deepEqual(text!.inbound, { kind: "text", text: "halo" });
  assert.equal(text!.timestamp.toISOString(), new Date(1758000000 * 1000).toISOString());
  const again = parseFonnteWebhook({ sender: "6281234", message: "halo", timestamp: 1758000000 });
  assert.equal(again[0]!.wamid, text!.wamid, "same message, same fingerprint");
  assert.equal(parseFonnteWebhook({ sender: "6281234", message: "halo", timestamp: 1758000000, inboxid: 55 })[0]!.wamid, "fonnte.in.55");
  const a = parseFonnteWebhook({ sender: "6281234", message: "halo", timestamp: 1758000000, inboxid: 0 })[0]!;
  const b = parseFonnteWebhook({ sender: "6281234", message: "1", timestamp: 1758000005, inboxid: "0" })[0]!;
  assert.notEqual(a.wamid, b.wamid, "inboxid 0 means no inbox id, not the same message");
  assert.match(a.wamid, /^fonnte\.fp\./);

  assert.deepEqual(parseFonnteWebhook({ sender: "120363@g.us", member: "6281", message: "halo grup" }), []);
  assert.deepEqual(parseFonnteWebhook("x"), []);

  const pdf = parseFonnteWebhook({ sender: "62812", message: "tolong ringkas", url: "https://f.example/a.pdf", filename: "kontrak.pdf", extension: "pdf" })[0]!;
  assert.deepEqual(pdf.inbound, { kind: "document", mediaId: "https://f.example/a.pdf", filename: "kontrak.pdf", mime: "application/pdf", caption: "tolong ringkas" });
  const voice = parseFonnteWebhook({ sender: "62812", message: "", url: "https://f.example/v.ogg", extension: "ogg" })[0]!;
  assert.deepEqual(voice.inbound, { kind: "audio", mediaId: "https://f.example/v.ogg", mime: "audio/ogg", voice: true });
  const photo = parseFonnteWebhook({ sender: "62812", message: "", url: "https://f.example/p.jpg", extension: "jpg" })[0]!;
  assert.equal(photo.inbound.kind, "image");

  for (const dropped of [
    { sender: "62812", message: "non-text message" },
    { sender: "62812", message: "Non text message " },
    { sender: "62812", message: "", filename: "kontrak.pdf" },
    { sender: "62812", message: "" },
  ]) {
    assert.deepEqual(parseFonnteWebhook(dropped)[0]!.inbound, { kind: "unsupported", type: "fonnte-empty" }, JSON.stringify(dropped));
  }
  assert.equal(parseFonnteWebhook({ sender: "62812", message: "ini bukan non-text message" })[0]!.inbound.kind, "text");
});

test("a location shared in WhatsApp is read even when Fonnte labels it a non-text message", () => {
  const [shared] = parseFonnteWebhook({ sender: "62812", message: "non-text message", location: "-6.2607,106.8134" });
  assert.deepEqual(shared!.inbound, { kind: "location", latitude: -6.2607, longitude: 106.8134 });
  const [spaced] = parseFonnteWebhook({ sender: "62812", message: "", location: " -6.2607 , 106.8134 " });
  assert.equal(spaced!.inbound.kind, "location");
  const [junk] = parseFonnteWebhook({ sender: "62812", message: "non-text message", location: "undefined" });
  assert.deepEqual(junk!.inbound, { kind: "unsupported", type: "fonnte-empty" }, "an empty location field is still a dropped message");

  assert.deepEqual(parsePoint("-6.2607;106.8134"), { lat: -6.2607, lng: 106.8134 });
  for (const bad of ["0,0", "95,10", "-6.2,190", "abc", "10.30, 11.00 rapat", ""]) assert.equal(parsePoint(bad), undefined, bad);

  assert.deepEqual(
    fonnteFieldsPresent({ sender: "62812", message: "non-text message", location: "", url: null, device: "628", token: "rahasia" }),
    ["device", "message", "sender", "token"],
    "names only, never values, so the log is safe to read",
  );
});

test("contact cards shared as vCard text become contacts", () => {
  const card = "BEGIN:VCARD\nVERSION:3.0\nN:Prasetyo;Andi;;;\nFN:Andi Prasetyo\nORG:Vendor X;\nitem1.TEL;waid=6281234567890:+62 812-3456-7890\nEND:VCARD";
  assert.deepEqual(parseVCards(card), [{ name: "Andi Prasetyo", phones: ["6281234567890"], emails: [], organization: "Vendor X" }]);
  const [msg] = parseFonnteWebhook({ sender: "62812", message: card });
  assert.equal(msg!.inbound.kind, "contacts");
});

test("InstanPay callback signature follows the documented algorithm", () => {
  const payload = { txn_id: 12, ref_id: "ORDER-123", status: "paid", amount: 25000, net_amount: 24825, is_sandbox: true, paid_at: "2026-08-17T01:29:49Z" };
  const manual = createHmac("sha256", "sk_test_abc")
    .update(JSON.stringify({ amount: 25000, is_sandbox: true, net_amount: 24825, paid_at: "2026-08-17T01:29:49Z", ref_id: "ORDER-123", status: "paid", txn_id: 12 }))
    .digest("hex");
  assert.equal(instanPaySignature({ ...payload, signature: "ignored" }, "sk_test_abc"), manual);
});

test("InstanPay creates a QRIS charge with the unique amount and hosted page", async () => {
  const { http, calls } = fakeFetch([
    json({
      ok: true,
      data: {
        txn_id: 12,
        ref_id: "MILO-1-X",
        mode: "sandbox",
        amount: 500000,
        unique_amount: 500017,
        qris_string: "00020101021226",
        payment_url: "https://pay.instanlive.id/pay/abc",
        status: "pending",
        expired_in_minutes: 15,
      },
    }),
    json({ ok: true, data: { txn_id: 12, status: "paid" } }),
    json({ ok: false, error: "invalid_state" }, 409),
    json({ ok: true, data: {} }),
  ]);
  const gw = new InstanPayProvider({ apiKey: "sk_test_abc", baseUrl: "https://pay.instanlive.id/api/v1" }, http);
  const charge = await gw.createQrisCharge({ orderId: "MILO-1-X", amountIdr: 500000, description: "Milo Profesional 1 bulan" });
  assert.equal(calls[0]!.url, "https://pay.instanlive.id/api/v1/transaction/create");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["X-Api-Key"], "sk_test_abc");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { ref_id: "MILO-1-X", amount: 500000, description: "Milo Profesional 1 bulan" });
  assert.equal(charge.providerRef, "12");
  assert.equal(charge.payAmountIdr, 500017);
  assert.equal(charge.paymentUrl, "https://pay.instanlive.id/pay/abc");
  assert.equal(charge.sandbox, true);
  assert.ok(Math.abs(charge.expiresAt.getTime() - (Date.now() + 15 * 60_000)) < 5000);

  assert.equal(await gw.checkStatus("12"), "paid");
  assert.equal(calls[1]!.url, "https://pay.instanlive.id/api/v1/transaction/status/12");
  await gw.cancel("12");
  await gw.simulatePaid("12");
  assert.equal(calls[3]!.url, "https://pay.instanlive.id/api/v1/sandbox/pay/12");
});

test("InstanPay callbacks are verified before they count", async () => {
  const gw = new InstanPayProvider({ apiKey: "sk_live_key", baseUrl: "https://x" }, (async () => new Response()) as typeof fetch);
  const payload: Record<string, unknown> = { txn_id: 7, ref_id: "MILO-2-Y", status: "paid", amount: 400000, net_amount: 397200, is_sandbox: false, paid_at: "2026-09-17T08:00:00Z" };
  payload.signature = instanPaySignature(payload, "sk_live_key");
  const req = (body: unknown) => ({ headers: {}, rawBody: Buffer.from(JSON.stringify(body)), body });
  assert.deepEqual(await gw.parseWebhook(req(payload)), { providerRef: "7", orderId: "MILO-2-Y", status: "paid" });
  await assert.rejects(gw.parseWebhook(req({ ...payload, amount: 1 })), /tanda tangan/);
  const sandboxBody: Record<string, unknown> = { ...payload, is_sandbox: true };
  sandboxBody.signature = instanPaySignature(sandboxBody, "sk_live_key");
  await assert.rejects(gw.parseWebhook(req(sandboxBody)), /mode callback/);
  await assert.rejects(gw.simulatePaid("7"), /sk_test_/);
});

test("payment caption shows the exact amount and the payment link", () => {
  const payment = {
    provider: "instanpay",
    plan: "profesional",
    months: 1,
    amountIdr: 500000,
    payAmountIdr: 500017,
    paymentUrl: "https://pay.instanlive.id/pay/abc",
    expiresAt: new Date("2026-09-17T08:15:00Z"),
  } as PaymentRow;
  const text = paymentCaption(payment, "Asia/Jakarta", true);
  assert.match(text, /Bayar \*tepat Rp500\.017\*/);
  assert.match(text, /kode unik Rp17/);
  assert.match(text, /https:\/\/pay\.instanlive\.id\/pay\/abc/);
  assert.match(text, /15\.15/);
  assert.match(text, /SANDBOX/);
});
