export interface QrisCharge {
  providerRef: string;
  qrString: string;
  expiresAt: Date;
  /** What the customer must pay when the gateway adds a unique suffix to identify the transfer. */
  payAmountIdr?: number;
  /** Hosted page that shows the same QRIS, for channels that cannot send images. */
  paymentUrl?: string;
  sandbox?: boolean;
}

export type RemoteStatus = "pending" | "paid" | "expired" | "cancelled" | "refunded";

export interface PaymentNotification {
  providerRef: string;
  orderId?: string;
  status: RemoteStatus;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  body: unknown;
}

export interface PaymentProvider {
  readonly name: string;
  createQrisCharge(input: {
    orderId: string;
    amountIdr: number;
    description: string;
    customerWaId: string;
    expiresAt: Date;
  }): Promise<QrisCharge>;
  /** Verifies and interprets a callback from the gateway. Throws on an unverifiable request. */
  parseWebhook(req: WebhookRequest): Promise<PaymentNotification | null>;
  /** Asks the gateway for the current status; some gateways only match incoming transfers when polled. */
  checkStatus?(providerRef: string): Promise<RemoteStatus>;
  cancel?(providerRef: string): Promise<void>;
  /** Sandbox only: marks a charge paid and triggers the gateway's own callback. */
  simulatePaid?(providerRef: string): Promise<void>;
}
