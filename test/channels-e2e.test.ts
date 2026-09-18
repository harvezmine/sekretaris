import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { Agent } from "../src/agent/run.ts";
import { runTool, toolsFor } from "../src/agent/tools.ts";
import { buildApp, type App } from "../src/app.ts";
import { config } from "../src/config.ts";
import { migrate, sql, type UserRow } from "../src/db/index.ts";
import { InstanPayProvider, instanPaySignature } from "../src/payments/instanpay.ts";
import { resetSeenBaseUrl } from "../src/uploads/links.ts";
import { DryRunClient } from "../src/wa/client.ts";
import { tinyPdf } from "./helpers.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const SECRET = "fonnte-secret-0123456789";
const agentTurns: string[] = [];
/** Stands in for the model: "kirim ke <nomor>: <teks>" calls message_send, everything else is echoed. */
const fakeAgent = {
  async modelFor() {
    return "deepseek-flash";
  },
  async run(u: UserRow, turn: string) {
    agentTurns.push(turn);
    const send = /kirim ke (\S+): (.+)$/s.exec(turn);
    if (send) {
      const outcome = await runTool({ user: u }, "message_send", { phone: send[1], text: send[2] });
      return { reply: `Siap. ${String(outcome.content)}`, runId: "0", steps: 2, costUsd: 0 };
    }
    return { reply: `Oke: ${turn}`, runId: "0", steps: 1, costUsd: 0 };
  },
} as unknown as Agent;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("kondisi tidak terpenuhi dalam batas waktu");
}

const userByWa = async (waId: string) => (await sql<UserRow[]>`select * from users where wa_id = ${waId}`)[0];

describe("channels and payment gateway", { skip: !enabled && "set TEST_DATABASE_URL to run" }, () => {
  before(async () => {
    await sql.unsafe("drop schema public cascade; create schema public;");
    await migrate();
  });
  after(async () => {
    await sql.end({ timeout: 5 });
  });

  describe("Fonnte", () => {
    let ctx: App;
    let wa: DryRunClient;
    let ts = 1758000000;

    const fonnte = async (sender: string, message: string, extra: Record<string, unknown> = {}, secret = SECRET) => {
      const res = await ctx.app.inject({
        method: "POST",
        url: `/fonnte/webhook/${secret}`,
        headers: { host: "milo-uji.trycloudflare.com" },
        payload: { device: "6280000", sender, name: "Bos", message, timestamp: ++ts, ...extra },
      });
      await ctx.debouncer.drain();
      return res;
    };
    const last = (to: string) => wa.sent.filter((e) => e.to === to && e.type !== "read").at(-1);
    const sentTo = (to: string) => wa.sent.filter((e) => e.to === to && e.type !== "read");
    const readyUser = async (waId: string, name = "Josh") => {
      const [u] = await sql<UserRow[]>`
        insert into users (wa_id, display_name, status, plan, state, consent_at, trial_ends_at, llm_model)
        values (${waId}, ${name}, 'trialing', 'trial', 'READY', now(), now() + interval '7 days', 'deepseek-flash')
        returning *
      `;
      return u!;
    };

    before(async () => {
      config.WA_PROVIDER = "fonnte";
      resetSeenBaseUrl();
      wa = new DryRunClient(`${process.env.DATA_DIR}/dry-run-fonnte`, () => {}, "fonnte");
      ctx = await buildApp({ wa, agent: fakeAgent, logger: false });
    });
    after(async () => {
      await ctx.debouncer.drain();
      await ctx.app.close();
    });

    test("a wrong secret is rejected", async () => {
      const res = await fonnte("6282200000001", "halo", {}, "salah");
      assert.equal(res.statusCode, 404);
      assert.equal(await userByWa("6282200000001"), undefined);
    });

    test("menus arrive as numbered text and number or title replies act as buttons", async () => {
      const u = "6282200000002";
      assert.equal((await fonnte(u, "halo")).statusCode, 200);
      const welcome = last(u)!;
      assert.equal(welcome.type, "text");
      assert.match(welcome.text!, /Halo Bos/);
      assert.ok(!/Balas dengan angka/.test(welcome.text!), "the first contact has nothing to pick from");

      await fonnte(u, "MENU");
      assert.match(last(u)!.text!, /Balas dengan angka:\n\*1\.\* Punya Kode\n\*2\.\* Lihat Harga\n\*3\.\* Tanya Dulu$/);

      await fonnte(u, "2");
      const out = wa.sent.filter((e) => e.to === u);
      assert.match(out.at(-2)!.text!, /Harga Milo/);
      assert.match(out.at(-1)!.text!, /\*1\.\* Langganan\n\*2\.\* Eksekutif\n\*3\.\* Punya Kode/);

      await fonnte(u, "punya kode");
      assert.equal(last(u)!.text, "Boleh, ketik kode undangannya di sini.");
      assert.equal((await userByWa(u))!.state, "AWAITING_CODE");

      await fonnte(u, "2");
      assert.match(last(u)!.text!, /Kodenya belum cocok/, "a bare number with no menu open is just text");
    });

    test("group messages and duplicate deliveries are ignored", async () => {
      const before = wa.sent.length;
      await fonnte("120363000@g.us", "halo grup", { member: "6282200000009" });
      assert.equal(wa.sent.length, before);

      const u = "6282200000003";
      const body = { device: "d", sender: u, name: "Bos", message: "halo", timestamp: 1759000000 };
      await ctx.app.inject({ method: "POST", url: `/fonnte/webhook/${SECRET}`, payload: body });
      await ctx.app.inject({ method: "POST", url: `/fonnte/webhook/${SECRET}`, payload: body });
      await ctx.debouncer.drain();
      const user = (await userByWa(u))!;
      const [{ n }] = await sql<{ n: string }[]>`select count(*) as n from messages where user_id = ${user.id} and direction = 'in'`;
      assert.equal(Number(n), 1);
    });

    test("files Fonnte does not forward get an upload link, and uploads are read like attachments", async () => {
      const u = "6282200000011";
      const user = await readyUser(u);
      const turnsBeforeDrop = agentTurns.length;
      await fonnte(u, "non-text message");
      const missing = last(u)!.text!;
      assert.match(missing, /dikirim langsung di WhatsApp belum bisa saya terima di nomor ini, termasuk keterangannya/);
      assert.match(missing, /https:\/\/milo-uji\.trycloudflare\.com\/u\/\S+/, "link built from the host the webhook came in on");
      assert.equal(agentTurns.length, turnsBeforeDrop, "Fonnte's placeholder never reaches the model");
      const noted = await sql<{ content: string }[]>`
        select t.content::text as content from transcript t join sessions s on s.id = t.session_id
        where s.user_id = ${user.id} order by t.id
      `;
      assert.match(noted[0]!.content, /tidak sampai\. Link unggah sudah dikirim/, "the model is told what happened");

      await fonnte(u, "FILE");
      const linkText = last(u)!.text!;
      const url = /https:\/\/milo-uji\.trycloudflare\.com(\/u\/\S+)/.exec(linkText)![1]!;
      assert.match(linkText, /berlaku 24 jam/);
      const transcript = await sql`select t.role from transcript t join sessions s on s.id = t.session_id where s.user_id = ${user.id}`;
      assert.equal(transcript.length, 4, "the link is recorded so the model knows it was given");

      const page = await ctx.app.inject({ url });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /Kirim file ke Milo/);
      assert.equal(page.headers["referrer-policy"], "no-referrer");
      assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);

      const upload = (body: Buffer, filename: string, caption = "", target = url) =>
        ctx.app.inject({
          method: "POST",
          url: target,
          headers: {
            "content-type": "application/octet-stream",
            "x-filename": encodeURIComponent(filename),
            "x-caption": encodeURIComponent(caption),
          },
          payload: body,
        });

      const turnsBefore = agentTurns.length;
      const res = await upload(tinyPdf("Laba bersih naik 7 persen"), "laporan Q3.pdf", "poin pentingnya apa?");
      assert.equal(res.statusCode, 200, res.body);
      await ctx.debouncer.drain();
      const saved = sentTo(u).at(-2)!.text!;
      assert.match(saved, /Tersimpan: \*laporan Q3\.pdf\*, 1 hlm/);
      assert.match(agentTurns.at(-1)!, /^\[Dokumen tersimpan #\d+: laporan Q3\.pdf, 1 hlm\]\npoin pentingnya apa\?$/);
      assert.equal(agentTurns.length, turnsBefore + 1);
      const [capture] = await sql<{ textContent: string; filePath: string }[]>`
        select text_content, file_path from captures where user_id = ${user.id} order by id desc limit 1
      `;
      assert.match(capture!.textContent, /Laba bersih naik 7 persen/);
      assert.match(capture!.filePath, /\.pdf$/);
      const staged = await readdir(path.join(process.env.DATA_DIR!, "uploads")).catch(() => []);
      assert.deepEqual(staged, [], "the staged upload is removed once saved");

      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
      assert.equal((await upload(png, "foto.png")).statusCode, 200);
      await ctx.debouncer.drain();
      const [photo] = await sql<{ kind: string; mime: string }[]>`
        select kind, mime from captures where user_id = ${user.id} order by id desc limit 1
      `;
      assert.deepEqual({ ...photo }, { kind: "image", mime: "image/png" });

      assert.equal((await upload(Buffer.from([0x4d, 0x5a, 0x90, 0x00]), "setup.exe")).statusCode, 415);
      assert.equal((await upload(Buffer.alloc(0), "kosong.pdf")).statusCode, 400);
      const forged = url.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
      assert.equal((await upload(tinyPdf("x"), "x.pdf", "", forged)).statusCode, 404);
      assert.equal((await ctx.app.inject({ url: forged })).statusCode, 404);

      await sql`update users set trial_ends_at = now() - interval '1 day' where id = ${user.id}`;
      assert.equal((await upload(tinyPdf("x"), "x.pdf")).statusCode, 404, "expired access closes the link");
    });

    test("messages to other people wait for Kirim, and replies are relayed to the owner", async () => {
      const owner = "6282200000021";
      const andi = "6281233334444";
      const ownerRow = await readyUser(owner, "Josh");
      const outsider = { ...ownerRow, waId: "6282200000099" };
      config.SERVER_ADMIN_NUMBERS = owner;
      try {
        const ownerTools = toolsFor(ownerRow).map((t) => t.name);
        const outsiderTools = toolsFor(outsider).map((t) => t.name);
        assert.ok(ownerTools.includes("message_send"));
        assert.ok(!outsiderTools.includes("message_send"));
        assert.ok(
          ![...ownerTools, ...outsiderTools].includes("message_draft"),
          "no tool hands out a wa.me link any more: Milo sends the message itself or not at all",
        );
        const denied = await runTool({ user: outsider }, "message_send", { phone: andi, text: "x" });
        assert.equal(denied.isError, true);

        await fonnte(owner, "kirim ke 0812-3333-4444: Halo Pak Andi, saya Milo, asisten Josh. Rapat jadi jam 3 sore.");
        const [reply, preview, confirm] = sentTo(owner).slice(-3);
        assert.match(reply!.text!, /menunggu konfirmasi pengguna/);
        assert.equal(
          preview!.text,
          "Halo Pak Andi, saya Milo, asisten Josh. Rapat jadi jam 3 sore.\n\n_— Milo, asisten pribadi Josh. Balas pesan ini untuk menjawab; balasan Anda akan saya teruskan._",
        );
        assert.match(
          confirm!.text!,
          /Saya kirim ke \*6281233334444\* sekarang\? Tombolnya berlaku 15 menit\.\n\nBalas dengan angka:\n\*1\.\* Kirim\n\*2\.\* Batal$/,
        );
        assert.equal(sentTo(andi).length, 0, "nothing goes out before the owner confirms");

        await fonnte(owner, "1");
        assert.equal(sentTo(andi).length, 1);
        assert.equal(sentTo(andi)[0]!.text, preview!.text);
        assert.match(last(owner)!.text!, /Sudah terkirim ke \*6281233334444\*/);
        await sql`insert into messages (user_id, direction, kind, body, payload, processed)
                  values (${ownerRow.id}, 'out', 'interactive', 'lama', ${sql.json({ buttons: confirm!.buttons } as never)}, true)`;
        await fonnte(owner, "1");
        assert.equal(sentTo(andi).length, 1, "tapping an old confirmation again does not send twice");
        assert.match(last(owner)!.text!, /sudah terkirim tadi/);

        await fonnte(andi, "Siap, saya datang", { name: "Andi" });
        assert.equal(last(owner)!.text, "💬 *Andi* membalas (6281233334444):\nSiap, saya datang");
        assert.equal(last(andi)!.text, "Terima kasih, pesan Anda sudah saya sampaikan ke Josh.\n\nSalam,\nMilo");
        assert.equal((await userByWa(andi))!.state, "NEW", "the recipient is not onboarded");
        await fonnte(andi, "Tolong siapkan proyektor", { name: "Andi" });
        assert.match(last(owner)!.text!, /Tolong siapkan proyektor/);
        assert.equal(sentTo(andi).length, 2, "thanked once per thread");

        await fonnte(owner, "apa kata Andi?");
        assert.match(
          agentTurns.at(-1)!,
          /^\[Balasan dari 6281233334444, .+: Siap, saya datang\]\n\[Balasan dari 6281233334444, .+: Tolong siapkan proyektor\]\napa kata Andi\?$/,
        );
        await fonnte(owner, "lagi?");
        assert.doesNotMatch(agentTurns.at(-1)!, /Balasan dari/, "each reply reaches the model once");

        await fonnte(owner, "kirim ke 081233334444: Pak Andi, rapatnya batal.");
        await fonnte(owner, "batal");
        assert.match(last(owner)!.text!, /tidak jadi dikirim/);
        assert.equal(sentTo(andi).length, 2);

        await fonnte(owner, "kirim ke 081233334444: Pak Andi, rapat pindah ke Jumat.");
        await sql`update relay_messages set expires_at = now() - interval '1 minute' where status = 'pending'`;
        await fonnte(owner, "kirim");
        assert.match(last(owner)!.text!, /sudah kedaluwarsa/);
        assert.equal(sentTo(andi).length, 2);

        config.MESSAGE_SEND_DAILY_LIMIT = 1;
        await fonnte(owner, "kirim ke 081233334444: satu lagi");
        assert.match(last(owner)!.text!, /Batas 1 pesan/);
        config.MESSAGE_SEND_DAILY_LIMIT = 20;

        await fonnte(andi, "STOP", { name: "Andi" });
        await fonnte(owner, "kirim ke 081233334444: halo lagi");
        assert.match(last(owner)!.text!, /tidak dikirimi pesan lagi/);

        const stranger = "6281255556666";
        await fonnte(stranger, "halo");
        assert.match(last(stranger)!.text!, /Halo Bos/, "people Milo never messaged still get the welcome");
      } finally {
        config.SERVER_ADMIN_NUMBERS = "";
        config.MESSAGE_SEND_DAILY_LIMIT = 20;
      }
    });

    test("the quick menu is a numbered list, and a number or title opens the action", async () => {
      const u = "6282200000031";
      await readyUser(u);
      await fonnte(u, "menu");
      const menu = last(u)!;
      assert.equal(menu.type, "text");
      assert.match(menu.text!, /Balas dengan angka:\n\*1\.\* 📅 Agenda hari ini — Pengingat hari ini dan besok\n\*2\.\* ⏰ Buat pengingat/);
      await fonnte(u, "1");
      assert.match(last(u)!.text!, /Agenda hari ini/);
      await fonnte(u, "menu");
      await fonnte(u, "profil saya");
      assert.match(sentTo(u).at(-2)!.text!, /Profil Anda/);
    });

    test("reminders go out as plain text regardless of the 24-hour window", async () => {
      const [u] = await sql<UserRow[]>`
        insert into users (wa_id, status, plan, state, consent_at, trial_ends_at, last_inbound_at, llm_model)
        values ('6282200000004', 'trialing', 'trial', 'READY', now(), now() + interval '7 days', now() - interval '3 days', 'deepseek-flash')
        returning *
      `;
      await sql`insert into reminders (user_id, kind, text, fire_at) values (${u!.id}, 'user', 'Bayar listrik', now() - interval '1 second')`;
      await ctx.scheduler.tick();
      assert.equal(last(u!.waId)!.text, "⏰ Ini pengingatnya:\nBayar listrik");
    });
  });

  describe("InstanPay", () => {
    let ctx: App;
    let wa: DryRunClient;
    const KEY = "sk_test_milo";
    const txns = new Map<string, { ref: string; amount: number; status: string }>();
    let nextId = 100;

    const gatewayFetch = (async (url: string | URL, init: RequestInit = {}) => {
      const u = new URL(String(url));
      const reply = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (u.pathname.endsWith("/transaction/create")) {
        const body = JSON.parse(String(init.body)) as { ref_id: string; amount: number };
        const id = String(nextId++);
        txns.set(id, { ref: body.ref_id, amount: body.amount, status: "pending" });
        return reply({
          ok: true,
          data: {
            txn_id: Number(id),
            ref_id: body.ref_id,
            mode: "sandbox",
            amount: body.amount,
            unique_amount: body.amount + 17,
            qris_string: `QRIS-${id}`,
            payment_url: `https://pay.instanlive.id/pay/${id}`,
            status: "pending",
            expired_in_minutes: 15,
          },
        });
      }
      const status = /\/transaction\/status\/(\d+)$/.exec(u.pathname);
      if (status) return reply({ ok: true, data: { txn_id: Number(status[1]), status: txns.get(status[1]!)?.status } });
      const cancel = /\/transaction\/cancel\/(\d+)$/.exec(u.pathname);
      if (cancel) {
        txns.get(cancel[1]!)!.status = "cancelled";
        return reply({ ok: true, data: {} });
      }
      return reply({ ok: false, error: "not_found" }, 404);
    }) as typeof fetch;

    const callback = (txnId: string, overrides: Record<string, unknown> = {}, key = KEY) => {
      const t = txns.get(txnId)!;
      const payload: Record<string, unknown> = {
        txn_id: Number(txnId),
        ref_id: t.ref,
        status: "paid",
        amount: t.amount,
        net_amount: t.amount - 3500,
        is_sandbox: true,
        paid_at: new Date().toISOString(),
        ...overrides,
      };
      payload.signature = instanPaySignature(payload, key);
      return ctx.app.inject({ method: "POST", url: "/pay/webhook", payload });
    };

    before(async () => {
      wa = new DryRunClient(`${process.env.DATA_DIR}/dry-run-pay`, () => {}, "fonnte");
      const provider = new InstanPayProvider({ apiKey: KEY, baseUrl: "https://pay.instanlive.id/api/v1" }, gatewayFetch);
      ctx = await buildApp({ wa, agent: fakeAgent, logger: false, paymentProvider: provider });
    });
    after(async () => {
      await ctx.debouncer.drain();
      await ctx.app.close();
    });

    const subscribe = async (waId: string) => {
      const [u] = await sql<UserRow[]>`insert into users (wa_id, state, consent_at) values (${waId}, 'MENU', now()) returning *`;
      await ctx.app.inject({
        method: "POST",
        url: `/fonnte/webhook/${SECRET}`,
        payload: { sender: waId, message: "Langganan", timestamp: Date.now() / 1000 },
      });
      await sql`insert into messages (user_id, direction, kind, body, payload, processed)
                values (${u!.id}, 'out', 'interactive', 'menu', ${sql.json({ buttons: [{ id: "subscribe", title: "Langganan" }] })}, true)`;
      await ctx.app.inject({
        method: "POST",
        url: `/fonnte/webhook/${SECRET}`,
        payload: { sender: waId, message: "1", timestamp: Date.now() / 1000 + 1 },
      });
      await ctx.debouncer.drain();
      const [p] = await sql<{ providerRef: string; payAmountIdr: number; paymentUrl: string }[]>`
        select provider_ref, pay_amount_idr, payment_url from payments where user_id = ${u!.id} order by id desc limit 1
      `;
      return { user: u!, payment: p! };
    };

    test("checkout shows the unique amount and hosted page; a signed callback activates", async () => {
      const waId = "6283300000001";
      const { payment } = await subscribe(waId);
      assert.equal(payment.payAmountIdr, 500017);
      assert.equal(payment.paymentUrl, `https://pay.instanlive.id/pay/${payment.providerRef}`);
      const image = wa.sent.find((e) => e.to === waId && e.type === "image")!;
      assert.match(image.text!, /Bayar \*tepat Rp500\.017\*/);
      assert.match(image.text!, new RegExp(`pay\\.instanlive\\.id/pay/${payment.providerRef}`));
      assert.equal((await userByWa(waId))!.state, "AWAITING_PAYMENT");

      const forged = await callback(payment.providerRef, {}, "sk_test_wrong");
      assert.equal(forged.statusCode, 400);
      const mismatch = await callback(payment.providerRef, { ref_id: "MILO-999-ZZZ" });
      assert.equal(mismatch.statusCode, 400);
      assert.equal((await userByWa(waId))!.status, "new");

      txns.get(payment.providerRef)!.status = "paid";
      const ok = await callback(payment.providerRef);
      assert.equal(ok.statusCode, 200);
      const user = (await userByWa(waId))!;
      assert.equal(user.status, "active");
      assert.equal(user.plan, "profesional");
      assert.ok(wa.sent.some((e) => e.to === waId && /Pembayaran diterima/.test(e.text ?? "")));
      assert.equal((await callback(payment.providerRef)).statusCode, 200, "a repeated callback is harmless");
    });

    test("polling catches a payment the callback never delivered", async () => {
      const waId = "6283300000002";
      const { payment } = await subscribe(waId);
      txns.get(payment.providerRef)!.status = "paid";
      await ctx.payments.pollOpen();
      await waitFor(async () => (await userByWa(waId))!.status === "active");
    });

    test("cancelling also cancels the charge at the gateway", async () => {
      const waId = "6283300000003";
      const { user, payment } = await subscribe(waId);
      await ctx.payments.cancelPending(user.id);
      assert.equal(txns.get(payment.providerRef)!.status, "cancelled");
      const [row] = await sql<{ status: string }[]>`select status from payments where provider_ref = ${payment.providerRef}`;
      assert.equal(row!.status, "cancelled");
    });
  });
});
