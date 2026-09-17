import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Agent } from "../src/agent/run.ts";
import { buildApp, type App } from "../src/app.ts";
import { migrate, sql, type UserRow } from "../src/db/index.ts";
import { InstanPayProvider, instanPaySignature } from "../src/payments/instanpay.ts";
import { DryRunClient } from "../src/wa/client.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const SECRET = "fonnte-secret-0123456789";
const fakeAgent = {
  async modelFor() {
    return "deepseek-flash";
  },
  async run(_u: UserRow, turn: string) {
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
        payload: { device: "6280000", sender, name: "Bos", message, timestamp: ++ts, ...extra },
      });
      await ctx.debouncer.drain();
      return res;
    };
    const last = (to: string) => wa.sent.filter((e) => e.to === to && e.type !== "read").at(-1);

    before(async () => {
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
      assert.match(welcome.text!, /Balas dengan angka:\n\*1\.\* Punya Kode\n\*2\.\* Lihat Harga\n\*3\.\* Tanya Dulu$/);

      await fonnte(u, "2");
      const out = wa.sent.filter((e) => e.to === u);
      assert.match(out.at(-2)!.text!, /Harga Milo/);
      assert.match(out.at(-1)!.text!, /\*1\.\* Langganan\n\*2\.\* Eksekutif\n\*3\.\* Punya Kode/);

      await fonnte(u, "punya kode");
      assert.equal(last(u)!.text, "Silakan ketik kode undangan Anda.");
      assert.equal((await userByWa(u))!.state, "AWAITING_CODE");

      await fonnte(u, "2");
      assert.match(last(u)!.text!, /tidak dikenali/, "a bare number with no menu open is just text");
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

    test("reminders go out as plain text regardless of the 24-hour window", async () => {
      const [u] = await sql<UserRow[]>`
        insert into users (wa_id, status, plan, state, consent_at, trial_ends_at, last_inbound_at, llm_model)
        values ('6282200000004', 'trialing', 'trial', 'READY', now(), now() + interval '7 days', now() - interval '3 days', 'deepseek-flash')
        returning *
      `;
      await sql`insert into reminders (user_id, kind, text, fire_at) values (${u!.id}, 'user', 'Bayar listrik', now() - interval '1 second')`;
      await ctx.scheduler.tick();
      assert.equal(last(u!.waId)!.text, "⏰ *Pengingat*\nBayar listrik");
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
      assert.match(wa.sent.filter((e) => e.to === waId).at(-1)!.text!, /Pembayaran diterima/);
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
