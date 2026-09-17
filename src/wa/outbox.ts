import { config } from "../config.js";
import { sql, type UserRow } from "../db/index.js";
import type { Button, WhatsApp } from "./client.js";
import { chunkText, toWhatsApp } from "./format.js";

type Recipient = Pick<UserRow, "id" | "waId">;

async function record(userId: string, wamid: string | null, kind: string, body: string | null, payload?: object) {
  await sql`
    insert into messages (user_id, wamid, direction, kind, body, payload, processed)
    values (${userId}, ${wamid}, 'out', ${kind}, ${body}, ${payload ? sql.json(payload as never) : null}, true)
    on conflict (wamid) do nothing
  `;
}

/** Every outbound message goes through here so the transcript of what the user actually saw stays complete. */
export class Outbox {
  constructor(readonly wa: WhatsApp) {}

  async text(user: Recipient, markdownOrText: string, opts: { raw?: boolean } = {}): Promise<void> {
    const body = opts.raw ? markdownOrText : toWhatsApp(markdownOrText);
    for (const part of chunkText(body)) {
      const wamid = await this.wa.sendText(user.waId, part);
      await record(user.id, wamid, "text", part);
    }
  }

  async buttons(user: Recipient, body: string, buttons: Button[], footer?: string): Promise<void> {
    const wamid = await this.wa.sendButtons(user.waId, body, buttons, footer);
    await record(user.id, wamid, "interactive", body, { buttons });
  }

  async image(user: Recipient, png: Buffer, caption?: string): Promise<void> {
    const wamid = await this.wa.sendImage(user.waId, png, caption);
    await record(user.id, wamid, "image", caption ?? null);
  }

  async template(user: Recipient, name: string, params: string[]): Promise<void> {
    const wamid = await this.wa.sendTemplate(user.waId, name, config.WA_TEMPLATE_LANG, params);
    await record(user.id, wamid, "template", params.join(" | "), { template: name });
    await sql`
      insert into usage_ledger (user_id, kind, units, cost_usd)
      values (${user.id}, 'wa_template', 1, ${config.WA_TEMPLATE_USD})
    `;
  }

  async typing(lastInboundWamid: string | undefined): Promise<void> {
    if (!lastInboundWamid) return;
    await this.wa.markReadTyping(lastInboundWamid).catch(() => {});
  }
}
