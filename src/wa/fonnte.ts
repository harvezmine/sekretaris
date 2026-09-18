import { createHash } from "node:crypto";
import { assertButtons, assertList, WhatsAppError, type Button, type MediaFile, type WhatsApp } from "./client.js";
import type { Inbound, InboundMessage, SharedContact } from "./inbound.js";
import { renderMenu } from "./menu.js";

type Fetch = typeof fetch;

/**
 * Fonnte links a regular WhatsApp account the way WhatsApp Web does. It is unofficial: there are no buttons, no
 * templates and no 24-hour window, and the number can be banned. Use a spare number.
 */
export class FonnteClient implements WhatsApp {
  readonly dryRun = false;
  readonly channel = "fonnte" as const;
  readonly supportsButtons = false;
  readonly serviceWindow = false;

  constructor(
    private readonly opts: { token: string; typing: boolean; baseUrl?: string },
    private readonly http: Fetch = fetch,
  ) {}

  private async send(fields: Record<string, string>, file?: { data: Buffer; name: string; type: string }): Promise<string | null> {
    const form = new FormData();
    form.append("countryCode", "0");
    if (this.opts.typing) {
      form.append("typing", "true");
      form.append("duration", "2");
    }
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    if (file) form.append("file", new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);

    const res = await this.http(`${this.opts.baseUrl ?? "https://api.fonnte.com"}/send`, {
      method: "POST",
      headers: { Authorization: this.opts.token },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: boolean; id?: (string | number)[]; reason?: string; detail?: string };
    if (!res.ok || json.status !== true) {
      throw new WhatsAppError(`Fonnte: ${json.reason ?? json.detail ?? `HTTP ${res.status}`}`, res.status, undefined);
    }
    const id = json.id?.[0];
    return id === undefined ? null : `fonnte.out.${id}`;
  }

  sendText(to: string, text: string) {
    return this.send({ target: to, message: text });
  }

  sendButtons(to: string, body: string, buttons: Button[]) {
    assertButtons(body, buttons);
    return this.send({ target: to, message: renderMenu(body, buttons) });
  }

  sendList(to: string, body: string, label: string, rows: Button[]) {
    assertList(body, label, rows);
    return this.send({ target: to, message: renderMenu(body, rows) });
  }

  async sendImage(to: string, png: Buffer, caption?: string) {
    try {
      return await this.send({ target: to, message: caption ?? "" }, { data: png, name: "qris.png", type: "image/png" });
    } catch (err) {
      if (!(err instanceof WhatsAppError)) throw err;
      const note = "_(Gambar tidak bisa dikirim dari paket Fonnte ini.)_";
      return this.sendText(to, caption ? `${caption}\n\n${note}` : note);
    }
  }

  sendTemplate(to: string, _name: string, _lang: string, bodyParams: string[]) {
    return this.sendText(to, bodyParams.join("\n"));
  }

  async markReadTyping() {}

  async downloadMedia(url: string, maxBytes: number): Promise<MediaFile> {
    const res = await this.http(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new WhatsAppError(`unduh lampiran gagal: HTTP ${res.status}`, res.status, undefined);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > maxBytes) throw new WhatsAppError(`lampiran terlalu besar (${data.length} byte)`, 413, undefined);
    return { data, mimeType: res.headers.get("content-type")?.split(";")[0] ?? mimeFromExtension(url) };
  }
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  csv: "text/csv",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  oga: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  vcf: "text/vcard",
};

function mimeFromExtension(nameOrUrl: string): string {
  const ext = nameOrUrl.split("?")[0]!.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

export function parseVCards(text: string): SharedContact[] {
  const cards = text.split(/BEGIN:VCARD/i).slice(1);
  return cards
    .map((card) => {
      const lines = card.split(/\r?\n/);
      const value = (line: string) => line.slice(line.indexOf(":") + 1).trim();
      const fn = lines.find((l) => /^FN[:;]/i.test(l));
      const org = lines.find((l) => /^ORG[:;]/i.test(l));
      const phones = lines
        .filter((l) => /^(item\d+\.)?TEL[:;]/i.test(l))
        .map((l) => {
          const waid = /waid=(\d+)/i.exec(l);
          return waid ? waid[1]! : value(l);
        });
      const emails = lines.filter((l) => /^(item\d+\.)?EMAIL[:;]/i.test(l)).map(value);
      return {
        name: fn ? value(fn) : "Tanpa nama",
        phones,
        emails,
        organization: org ? value(org).replace(/;+$/, "") : undefined,
      };
    })
    .filter((c) => c.phones.length || c.emails.length);
}

const FONNTE_PLACEHOLDER = /^non[- ]?text message$/i;

/** "-6.2607,106.8134" (spaces allowed) into a point, or undefined for anything that is not a real coordinate. */
export function parsePoint(raw: string): { lat: number; lng: number } | undefined {
  const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(raw);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return undefined;
  return { lat, lng };
}

/**
 * Which fields a webhook actually carried, without their values: when a message cannot be read, this is what
 * tells the operator whether it was a file on the free package, a live location, or something new.
 */
export function fonnteFieldsPresent(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  return Object.entries(body as Record<string, unknown>)
    .filter(([, v]) => v !== "" && v !== null && v !== undefined && v !== 0 && v !== "0")
    .map(([k]) => k)
    .sort();
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Fonnte posts one JSON object per incoming message; group messages carry a `member` and are ignored. */
export function parseFonnteWebhook(body: unknown): InboundMessage[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  const b = body as Record<string, unknown>;
  const sender = str(b.sender).replace(/\D/g, "");
  if (!sender || str(b.member)) return [];

  const message = str(b.message);
  const url = str(b.url);
  const filename = str(b.filename) || undefined;
  const extension = (str(b.extension) || (filename ?? url).split("?")[0]!.split(".").pop() || "").toLowerCase();
  const tsRaw = Number(str(b.timestamp));
  const timestamp = Number.isFinite(tsRaw) && tsRaw > 0 ? new Date(tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : new Date();

  let inbound: Inbound;
  // A shared location comes as "lat,long" in its own field, on every package, next to the same placeholder text
  // Fonnte uses for files; it has to be read first or the placeholder would make it look like a dropped file.
  const point = parsePoint(str(b.location));
  // Without the attachment feature, Fonnte forwards a file or photo as this placeholder text, with no caption.
  const attachmentDropped = !url && (FONNTE_PLACEHOLDER.test(message.trim()) || Boolean(filename || str(b.extension)));
  if (point) {
    inbound = { kind: "location", latitude: point.lat, longitude: point.lng };
  } else if (attachmentDropped) {
    inbound = { kind: "unsupported", type: "fonnte-empty" };
  } else if (url) {
    const mime = MIME[extension];
    const caption = message || undefined;
    if (extension === "vcf") inbound = { kind: "unsupported", type: "vcard-url" };
    else if (mime?.startsWith("image/")) inbound = { kind: "image", mediaId: url, mime, caption };
    else if (mime?.startsWith("audio/")) inbound = { kind: "audio", mediaId: url, mime, voice: ["ogg", "opus", "oga"].includes(extension) };
    else if (mime?.startsWith("video/")) inbound = { kind: "video", mediaId: url, mime, caption };
    else inbound = { kind: "document", mediaId: url, filename: filename ?? `lampiran.${extension || "bin"}`, mime, caption };
  } else if (/BEGIN:VCARD/i.test(message)) {
    const contacts = parseVCards(message);
    inbound = contacts.length ? { kind: "contacts", contacts } : { kind: "text", text: message };
  } else if (message) {
    inbound = { kind: "text", text: message };
  } else {
    inbound = { kind: "unsupported", type: "fonnte-empty" };
  }

  // Fonnte sends inboxid 0 when its inbox feature is off; only a positive id identifies a message.
  const inboxId = Number(str(b.inboxid)) > 0 ? str(b.inboxid) : "";
  const fingerprint = createHash("sha256")
    .update([sender, str(b.timestamp) || String(Math.floor(Date.now() / 1000)), message, url].join("|"))
    .digest("hex")
    .slice(0, 32);
  return [
    {
      wamid: inboxId ? `fonnte.in.${inboxId}` : `fonnte.fp.${fingerprint}`,
      from: sender,
      profileName: str(b.name) || undefined,
      timestamp,
      inbound,
    },
  ];
}
