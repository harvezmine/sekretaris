import type { PaymentProvider, QrisCharge } from "./provider.js";

/** Test mode: issues a QR that no bank will accept; payment is confirmed by a timer or by an admin. */
export class BypassProvider implements PaymentProvider {
  readonly name = "bypass";

  async createQrisCharge(input: { orderId: string; amountIdr: number; expiresAt: Date }): Promise<QrisCharge> {
    return {
      providerRef: `bypass-${input.orderId}`,
      qrString: `MILO-MODE-UJI|${input.orderId}|${input.amountIdr}`,
      expiresAt: input.expiresAt,
    };
  }

  async parseWebhook() {
    return null;
  }
}
