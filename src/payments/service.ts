import QRCode from "qrcode";
import { config } from "../config.js";
import { getUser, sql, updateUser, type UserRow } from "../db/index.js";
import { paidActivated } from "../onboarding/copy.js";
import type { Outbox } from "../wa/outbox.js";
import { addDays, addMonths, formatDate, formatIdr, type Logger } from "../util.js";
import { BypassProvider } from "./bypass.js";
import { InstanPayProvider } from "./instanpay.js";
import type { PaymentNotification, PaymentProvider } from "./provider.js";

export type PaidPlan = "pendiri" | "profesional";

export interface PaymentRow {
  id: string;
  userId: string | null;
  provider: string;
  providerRef: string;
  orderId: string;
  plan: PaidPlan;
  months: number;
  amountIdr: number;
  payAmountIdr: number | null;
  paymentUrl: string | null;
  status: "pending" | "paid" | "expired" | "failed" | "cancelled" | "refunded";
  qrString: string;
  expiresAt: Date;
  paidAt: Date | null;
}

export const PLAN_LABEL: Record<PaidPlan, string> = {
  pendiri: "Harga Pendiri",
  profesional: "Profesional",
};

export function priceFor(plan: PaidPlan): number {
  return plan === "pendiri" ? config.PRICE_PENDIRI_IDR : config.PRICE_PROFESIONAL_IDR;
}

export function createProvider(): PaymentProvider {
  if (config.PAYMENT_MODE === "instanpay") {
    return new InstanPayProvider({ apiKey: config.INSTANPAY_API_KEY, baseUrl: config.INSTANPAY_BASE_URL });
  }
  return new BypassProvider();
}

export async function qrPng(qrString: string): Promise<Buffer> {
  return QRCode.toBuffer(qrString, { type: "png", width: 640, margin: 2, errorCorrectionLevel: "M" });
}

function timeIn(date: Date, timeZone: string): string {
  return date.toLocaleTimeString("id-ID", { timeZone, hour: "2-digit", minute: "2-digit" });
}

export function paymentCaption(payment: PaymentRow, timeZone: string, sandbox: boolean): string {
  const pay = payment.payAmountIdr ?? payment.amountIdr;
  const lines = [`*${PLAN_LABEL[payment.plan]} — ${payment.months} bulan*`];
  if (pay !== payment.amountIdr) {
    lines.push(
      `Bayar *tepat ${formatIdr(pay)}*`,
      `_(${formatIdr(payment.amountIdr)} + kode unik ${formatIdr(pay - payment.amountIdr)} supaya pembayaran Anda langsung dikenali)_`,
    );
  } else {
    lines.push(`Total: *${formatIdr(pay)}*`);
  }
  lines.push("");
  lines.push(payment.paymentUrl ? "Scan QRIS ini dari m-banking atau e-wallet, atau buka halaman bayar:" : "Scan QRIS ini dari m-banking atau e-wallet apa pun.");
  if (payment.paymentUrl) lines.push(payment.paymentUrl);
  lines.push("", `Berlaku sampai ${formatDate(payment.expiresAt, timeZone)} pukul ${timeIn(payment.expiresAt, timeZone)}.`);
  if (payment.provider === "bypass") lines.push("", "_[MODE UJI] QR ini tidak bisa dibayar; pembayaran dikonfirmasi otomatis._");
  else if (sandbox) lines.push("", "_[SANDBOX] Pembayaran uji — tidak ada uang sungguhan._");
  return lines.join("\n");
}

export class Payments {
  /** Set by the app so a new subscriber goes through the same welcome as a new trial. */
  onActivated?: (user: UserRow, message: string) => Promise<void>;

  constructor(
    readonly provider: PaymentProvider,
    private readonly outbox: Outbox,
    private readonly log: Logger,
  ) {}

  private get sandbox(): boolean {
    return this.provider instanceof InstanPayProvider && this.provider.sandbox;
  }

  async pendingFor(userId: string): Promise<PaymentRow | undefined> {
    const [row] = await sql<PaymentRow[]>`
      select * from payments where user_id = ${userId} and status = 'pending' order by id desc limit 1
    `;
    return row;
  }

  /** Creates a QRIS charge and sends it. Reuses a still-valid pending charge for the same plan. */
  async checkout(user: UserRow, plan: PaidPlan, months = 1): Promise<PaymentRow> {
    const existing = await this.pendingFor(user.id);
    if (existing && existing.plan === plan && existing.months === months && existing.expiresAt.getTime() > Date.now() + 60_000) {
      await this.sendQr(user, existing);
      return existing;
    }
    if (existing) await this.cancelPending(user.id);

    const amount = priceFor(plan) * months;
    const orderId = `MILO-${user.id}-${Date.now().toString(36).toUpperCase()}`;
    const expiresAt = new Date(Date.now() + config.PAYMENT_EXPIRY_MINUTES * 60_000);
    const charge = await this.provider.createQrisCharge({
      orderId,
      amountIdr: amount,
      description: `Milo ${PLAN_LABEL[plan]} ${months} bulan`,
      customerWaId: user.waId,
      expiresAt,
    });
    const [row] = await sql<PaymentRow[]>`
      insert into payments
        (user_id, provider, provider_ref, order_id, plan, months, amount_idr, pay_amount_idr, payment_url, qr_string, expires_at)
      values
        (${user.id}, ${this.provider.name}, ${charge.providerRef}, ${orderId}, ${plan}, ${months}, ${amount},
         ${charge.payAmountIdr ?? amount}, ${charge.paymentUrl ?? null}, ${charge.qrString}, ${charge.expiresAt})
      returning *
    `;
    const payment = row!;
    await this.sendQr(user, payment);
    this.scheduleAutoPay(payment);
    return payment;
  }

  private scheduleAutoPay(payment: PaymentRow): void {
    if (this.provider.name === "bypass" && config.PAYMENT_BYPASS_DELAY_MS >= 0) {
      setTimeout(() => {
        this.markPaid(payment.providerRef).catch((err) => this.log.error({ err }, "bypass: konfirmasi gagal"));
      }, config.PAYMENT_BYPASS_DELAY_MS).unref();
    } else if (this.sandbox && this.provider.simulatePaid && config.INSTANPAY_SANDBOX_AUTOPAY_MS >= 0) {
      setTimeout(() => {
        this.provider
          .simulatePaid!(payment.providerRef)
          .then(() => this.pollOne(payment))
          .catch((err) => this.log.error({ err }, "sandbox: simulasi bayar gagal"));
      }, config.INSTANPAY_SANDBOX_AUTOPAY_MS).unref();
    }
  }

  async sendQr(user: UserRow, payment: PaymentRow): Promise<void> {
    const png = await qrPng(payment.qrString);
    await this.outbox.image(user, png, paymentCaption(payment, user.timezone, this.sandbox));
  }

  /** Applies a verified gateway callback. The order id must match the charge it claims to settle. */
  async handleNotification(note: PaymentNotification): Promise<void> {
    const [payment] = await sql<PaymentRow[]>`
      select * from payments where provider = ${this.provider.name} and provider_ref = ${note.providerRef}
    `;
    if (!payment) {
      this.log.warn({ providerRef: note.providerRef }, "callback untuk transaksi yang tidak dikenal");
      return;
    }
    if (note.orderId && note.orderId !== payment.orderId) {
      throw new Error(`ref_id ${note.orderId} tidak cocok dengan transaksi ${payment.orderId}`);
    }
    await this.applyStatus(payment, note.status);
  }

  private async applyStatus(payment: PaymentRow, status: PaymentNotification["status"]): Promise<void> {
    switch (status) {
      case "paid":
        await this.markPaid(payment.providerRef);
        break;
      case "expired":
      case "cancelled":
        await sql`update payments set status = ${status === "expired" ? "expired" : "cancelled"} where id = ${payment.id} and status = 'pending'`;
        break;
      case "refunded":
        await sql`update payments set status = 'refunded' where id = ${payment.id}`;
        this.log.warn({ orderId: payment.orderId, userId: payment.userId }, "pembayaran di-refund; periksa masa aktif pengguna secara manual");
        break;
      case "pending":
        break;
    }
  }

  private async pollOne(payment: PaymentRow): Promise<void> {
    if (!this.provider.checkStatus) return;
    await sql`update payments set checked_at = now() where id = ${payment.id}`;
    const status = await this.provider.checkStatus(payment.providerRef);
    await this.applyStatus(payment, status);
  }

  /**
   * Some gateways only match an incoming transfer when its status is queried, so open charges (and ones that
   * expired recently, in case the customer paid at the last second) are polled.
   */
  async pollOpen(): Promise<void> {
    if (!this.provider.checkStatus) return;
    const open = await sql<PaymentRow[]>`
      select * from payments
      where provider = ${this.provider.name}
        and (status = 'pending' or (status = 'expired' and expires_at > now() - interval '30 minutes'))
        and (checked_at is null or checked_at < now() - interval '20 seconds')
      order by id
      limit 20
    `;
    for (const payment of open) {
      try {
        await this.pollOne(payment);
      } catch (err) {
        this.log.warn({ err, orderId: payment.orderId }, "cek status pembayaran gagal");
      }
    }
  }

  /** Idempotent: a repeated or late notification for an already-settled charge does nothing. */
  async markPaid(providerRef: string): Promise<boolean> {
    const [payment] = await sql<PaymentRow[]>`
      update payments set status = 'paid', paid_at = now()
      where provider = ${this.provider.name} and provider_ref = ${providerRef} and status in ('pending', 'expired')
      returning *
    `;
    if (!payment) return false;

    const user = payment.userId ? await getUser(payment.userId) : undefined;
    if (!user) return true;
    const base = user.periodEndsAt && user.periodEndsAt.getTime() > Date.now() ? user.periodEndsAt : new Date();
    const periodEndsAt = addMonths(base, payment.months);
    const updated = await updateUser(user.id, {
      status: "active",
      plan: payment.plan,
      state: "READY",
      stateData: {},
      periodEndsAt,
      ...(user.consentAt ? {} : { consentAt: new Date() }),
    });
    await sql`update reminders set status = 'cancelled' where user_id = ${user.id} and kind = 'trial_nudge' and status = 'scheduled'`;
    this.log.info({ userId: user.id, plan: payment.plan, orderId: payment.orderId }, "pembayaran diterima");
    const message = paidActivated(PLAN_LABEL[payment.plan], periodEndsAt, updated.timezone);
    if (this.onActivated) await this.onActivated(updated, message);
    else await this.outbox.text(updated, message, { raw: true });
    return true;
  }

  async cancelPending(userId: string): Promise<void> {
    const pending = await sql<PaymentRow[]>`
      update payments set status = 'cancelled' where user_id = ${userId} and status = 'pending' returning *
    `;
    for (const p of pending) {
      await this.provider.cancel?.(p.providerRef).catch((err) => this.log.warn({ err, orderId: p.orderId }, "pembatalan di gateway gagal"));
    }
  }
}

export function hasAccess(user: UserRow, now = new Date()): boolean {
  if (user.status === "trialing") return Boolean(user.trialEndsAt && user.trialEndsAt > now);
  if (user.status === "active") return Boolean(user.periodEndsAt && addDays(user.periodEndsAt, config.GRACE_DAYS) > now);
  return false;
}
