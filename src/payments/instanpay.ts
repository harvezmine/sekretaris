import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentNotification, PaymentProvider, QrisCharge, RemoteStatus, WebhookRequest } from "./provider.js";

type Fetch = typeof fetch;

export class InstanPayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "InstanPayError";
  }
}

const STATUSES: RemoteStatus[] = ["pending", "paid", "expired", "cancelled", "refunded"];

function asStatus(value: unknown): RemoteStatus {
  return STATUSES.includes(value as RemoteStatus) ? (value as RemoteStatus) : "pending";
}

/**
 * Signature = hex HMAC-SHA256 over the callback JSON without `signature`, top-level keys sorted ascending,
 * keyed with the API key of the same mode (sandbox or live).
 */
export function instanPaySignature(payload: Record<string, unknown>, apiKey: string): string {
  const { signature: _ignored, ...data } = payload;
  const sorted = Object.fromEntries(Object.keys(data).sort().map((k) => [k, data[k]]));
  return createHmac("sha256", apiKey).update(JSON.stringify(sorted)).digest("hex");
}

/** InstanPay (pay.instanlive.id): dynamic QRIS with a unique amount; sk_test_ keys run in sandbox. */
export class InstanPayProvider implements PaymentProvider {
  readonly name = "instanpay";
  readonly sandbox: boolean;

  constructor(
    private readonly opts: { apiKey: string; baseUrl: string },
    private readonly http: Fetch = fetch,
  ) {
    this.sandbox = opts.apiKey.startsWith("sk_test_");
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
    const res = await this.http(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: { "X-Api-Key": this.opts.apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string; message?: string };
    if (!res.ok || json.ok !== true) {
      const code = json.error;
      throw new InstanPayError(`InstanPay ${res.status}${code ? ` ${code}` : ""}${json.message ? `: ${json.message}` : ""}`, res.status, code);
    }
    return json.data as T;
  }

  async createQrisCharge(input: { orderId: string; amountIdr: number; description: string }): Promise<QrisCharge> {
    const data = await this.call<{
      txn_id: number | string;
      unique_amount?: number;
      qris_string: string;
      payment_url?: string;
      expired_in_minutes?: number;
      mode?: string;
    }>("POST", "/transaction/create", {
      ref_id: input.orderId,
      amount: input.amountIdr,
      description: input.description.slice(0, 120),
    });
    if (!data?.qris_string) throw new InstanPayError("InstanPay: respons tanpa qris_string", 502, undefined);
    return {
      providerRef: String(data.txn_id),
      qrString: data.qris_string,
      expiresAt: new Date(Date.now() + (data.expired_in_minutes ?? 15) * 60_000),
      payAmountIdr: data.unique_amount ?? input.amountIdr,
      paymentUrl: data.payment_url,
      sandbox: data.mode ? data.mode === "sandbox" : this.sandbox,
    };
  }

  async checkStatus(providerRef: string): Promise<RemoteStatus> {
    const data = await this.call<{ status?: string }>("GET", `/transaction/status/${encodeURIComponent(providerRef)}`);
    return asStatus(data?.status);
  }

  async cancel(providerRef: string): Promise<void> {
    try {
      await this.call("POST", `/transaction/cancel/${encodeURIComponent(providerRef)}`);
    } catch (err) {
      if (err instanceof InstanPayError && err.code === "invalid_state") return;
      throw err;
    }
  }

  async simulatePaid(providerRef: string): Promise<void> {
    if (!this.sandbox) throw new InstanPayError("simulasi hanya untuk key sk_test_", 403, "live_mode");
    await this.call("POST", `/sandbox/pay/${encodeURIComponent(providerRef)}`);
  }

  async parseWebhook(req: WebhookRequest): Promise<PaymentNotification | null> {
    const body = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("callback bukan objek JSON");
    const payload = body as Record<string, unknown>;
    const given = typeof payload.signature === "string" ? payload.signature : "";
    const expected = instanPaySignature(payload, this.opts.apiKey);
    const a = Buffer.from(given, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("tanda tangan callback tidak cocok");
    if (typeof payload.is_sandbox === "boolean" && payload.is_sandbox !== this.sandbox) {
      throw new Error("mode callback (sandbox/live) tidak sesuai dengan API key");
    }
    if (payload.txn_id === undefined) return null;
    return {
      providerRef: String(payload.txn_id),
      orderId: typeof payload.ref_id === "string" ? payload.ref_id : undefined,
      status: asStatus(payload.status),
    };
  }
}
