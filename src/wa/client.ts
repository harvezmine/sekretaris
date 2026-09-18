import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderChoices } from "./menu.js";

export interface Button {
  id: string;
  title: string;
  /** List rows only: a second line under the title. */
  description?: string;
  /** Other words that count as choosing this, beyond the title itself. */
  say?: readonly string[];
  /** Marks the two answers to a plain question, so "oke" or "jangan" is enough to answer it. */
  answer?: "yes" | "no";
}

export interface MediaFile {
  data: Buffer;
  mimeType: string;
}

export interface WhatsApp {
  readonly dryRun: boolean;
  readonly channel: "meta" | "fonnte";
  /** Reply buttons render natively; otherwise menus arrive as numbered text. */
  readonly supportsButtons: boolean;
  /** Free-form messages are only allowed within 24 hours of the user's last message. */
  readonly serviceWindow: boolean;
  sendText(to: string, text: string): Promise<string | null>;
  sendButtons(to: string, body: string, buttons: Button[], footer?: string): Promise<string | null>;
  /** Up to ten choices: a list message on Meta, a numbered menu elsewhere. */
  sendList(to: string, body: string, label: string, rows: Button[]): Promise<string | null>;
  sendImage(to: string, png: Buffer, caption?: string): Promise<string | null>;
  sendTemplate(to: string, name: string, lang: string, bodyParams: string[]): Promise<string | null>;
  markReadTyping(messageId: string): Promise<void>;
  downloadMedia(mediaId: string, maxBytes: number): Promise<MediaFile>;
}

export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | undefined,
  ) {
    super(message);
    this.name = "WhatsAppError";
  }

  /** 131047: more than 24 hours since the user last wrote, so only templates are allowed. */
  get outsideWindow(): boolean {
    return this.code === 131047;
  }
}

export function assertButtons(body: string, buttons: Button[]): void {
  if (buttons.length < 1 || buttons.length > 3) throw new Error("WhatsApp: tombol harus 1–3");
  for (const b of buttons) {
    if (b.title.length > 20) throw new Error(`WhatsApp: judul tombol >20 karakter: "${b.title}"`);
  }
  if (body.length > 1024) throw new Error("WhatsApp: teks pesan bertombol maksimal 1024 karakter");
}

export function assertList(body: string, label: string, rows: Button[]): void {
  if (rows.length < 1 || rows.length > 10) throw new Error("WhatsApp: daftar harus 1–10 baris");
  if (label.length > 20) throw new Error(`WhatsApp: label daftar >20 karakter: "${label}"`);
  for (const r of rows) {
    if (r.title.length > 24) throw new Error(`WhatsApp: judul baris >24 karakter: "${r.title}"`);
    if ((r.description?.length ?? 0) > 72) throw new Error(`WhatsApp: deskripsi baris >72 karakter: "${r.description}"`);
  }
  if (body.length > 4096) throw new Error("WhatsApp: teks daftar maksimal 4096 karakter");
}

export class CloudApiClient implements WhatsApp {
  readonly dryRun = false;
  readonly channel = "meta" as const;
  readonly supportsButtons = true;
  readonly serviceWindow = true;
  private readonly base: string;

  constructor(private readonly opts: { phoneNumberId: string; accessToken: string; graphVersion: string }) {
    this.base = `https://graph.facebook.com/${opts.graphVersion}`;
  }

  private async call(pathname: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}/${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.opts.accessToken}`, ...((init.headers as Record<string, string>) ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (json.error ?? {}) as { message?: string; code?: number };
      throw new WhatsAppError(err.message ?? `HTTP ${res.status}`, res.status, err.code);
    }
    return json;
  }

  private async send(payload: Record<string, unknown>): Promise<string | null> {
    const json = await this.call(`${this.opts.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
    });
    const messages = json.messages as { id?: string }[] | undefined;
    return messages?.[0]?.id ?? null;
  }

  sendText(to: string, text: string) {
    return this.send({ to, type: "text", text: { body: text, preview_url: true } });
  }

  sendButtons(to: string, body: string, buttons: Button[], footer?: string) {
    assertButtons(body, buttons);
    return this.send({
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        ...(footer ? { footer: { text: footer } } : {}),
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
      },
    });
  }

  sendList(to: string, body: string, label: string, rows: Button[]) {
    assertList(body, label, rows);
    return this.send({
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: {
          button: label,
          sections: [
            {
              title: label,
              rows: rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })),
            },
          ],
        },
      },
    });
  }

  async sendImage(to: string, png: Buffer, caption?: string) {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "image/png");
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "image.png");
    const uploaded = await this.call(`${this.opts.phoneNumberId}/media`, { method: "POST", body: form });
    const id = uploaded.id as string | undefined;
    if (!id) throw new WhatsAppError("unggah media tidak mengembalikan id", 500, undefined);
    return this.send({ to, type: "image", image: { id, ...(caption ? { caption } : {}) } });
  }

  sendTemplate(to: string, name: string, lang: string, bodyParams: string[]) {
    return this.send({
      to,
      type: "template",
      template: {
        name,
        language: { code: lang },
        components: bodyParams.length
          ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }]
          : [],
      },
    });
  }

  async markReadTyping(messageId: string) {
    await this.call(`${this.opts.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
    });
  }

  async downloadMedia(mediaId: string, maxBytes: number): Promise<MediaFile> {
    const meta = await this.call(mediaId, { method: "GET" });
    const url = meta.url as string | undefined;
    const size = Number(meta.file_size ?? 0);
    if (!url) throw new WhatsAppError("media tidak punya url", 404, undefined);
    if (size > maxBytes) throw new WhatsAppError(`media terlalu besar (${size} byte)`, 413, undefined);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.opts.accessToken}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new WhatsAppError(`unduh media gagal: HTTP ${res.status}`, res.status, undefined);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > maxBytes) throw new WhatsAppError(`media terlalu besar (${data.length} byte)`, 413, undefined);
    const mimeType = (meta.mime_type as string | undefined) ?? res.headers.get("content-type") ?? "application/octet-stream";
    return { data, mimeType };
  }
}

export interface DryRunEntry {
  to: string;
  type: "text" | "buttons" | "list" | "image" | "template" | "read";
  text?: string;
  buttons?: Button[];
  template?: string;
  file?: string;
  at: Date;
}

/** Records outbound messages instead of calling Meta; media downloads come from an in-memory fixtures map. */
export class DryRunClient implements WhatsApp {
  readonly dryRun = true;
  readonly sent: DryRunEntry[] = [];
  readonly media = new Map<string, MediaFile>();
  readonly channel: "meta" | "fonnte";
  readonly supportsButtons: boolean;
  readonly serviceWindow: boolean;
  private counter = 0;

  /** Mimics the chosen channel's limits, so a Fonnte dry run shows numbered menus instead of buttons. */
  constructor(
    private readonly outDir: string,
    private readonly log: (entry: DryRunEntry) => void = () => {},
    channel: "meta" | "fonnte" = "meta",
  ) {
    this.channel = channel;
    this.supportsButtons = channel === "meta";
    this.serviceWindow = channel === "meta";
  }

  private record(entry: Omit<DryRunEntry, "at">): string {
    const full = { ...entry, at: new Date() };
    this.sent.push(full);
    this.log(full);
    return `wamid.dryrun.${randomUUID()}.${++this.counter}`;
  }

  async sendText(to: string, text: string) {
    return this.record({ to, type: "text", text });
  }

  async sendButtons(to: string, body: string, buttons: Button[]) {
    assertButtons(body, buttons);
    if (!this.supportsButtons) return this.record({ to, type: "text", text: body, buttons });
    return this.record({ to, type: "buttons", text: body, buttons });
  }

  async sendList(to: string, body: string, label: string, rows: Button[]) {
    assertList(body, label, rows);
    if (!this.supportsButtons) return this.record({ to, type: "text", text: renderChoices(body, rows), buttons: rows });
    return this.record({ to, type: "list", text: body, buttons: rows });
  }

  async sendImage(to: string, png: Buffer, caption?: string) {
    await mkdir(this.outDir, { recursive: true });
    const file = path.join(this.outDir, `image-${Date.now()}-${this.counter + 1}.png`);
    await writeFile(file, png);
    return this.record({ to, type: "image", text: caption, file });
  }

  async sendTemplate(to: string, name: string, _lang: string, bodyParams: string[]) {
    return this.record({ to, type: "template", template: name, text: bodyParams.join(" | ") });
  }

  async markReadTyping(messageId: string) {
    this.record({ to: messageId, type: "read" });
  }

  async downloadMedia(mediaId: string): Promise<MediaFile> {
    const file = this.media.get(mediaId);
    if (!file) throw new WhatsAppError(`dry-run: media ${mediaId} tidak ada`, 404, undefined);
    return file;
  }
}
