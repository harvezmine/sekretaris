import { callGoogle, ENDPOINTS, SCOPE } from "./client.js";
import { buildMime, decodeBase64Url, htmlToText, type OutgoingMail } from "./mime.js";

const MSG = `${ENDPOINTS.gmail}/users/me/messages`;
const READ = [SCOPE.gmailRead];
const SEND = [SCOPE.gmailSend];

interface Header {
  name: string;
  value: string;
}

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
}

interface ApiMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: Part;
}

export interface MailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: Date | null;
  snippet: string;
  unread: boolean;
}

export interface MailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MailMessage extends MailSummary {
  cc: string;
  messageId: string;
  references: string;
  body: string;
  attachments: MailAttachment[];
}

const header = (m: ApiMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function summarize(m: ApiMessage): MailSummary {
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m, "From"),
    to: header(m, "To"),
    subject: header(m, "Subject") || "(tanpa subjek)",
    date: m.internalDate ? new Date(Number(m.internalDate)) : null,
    snippet: (m.snippet ?? "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
    unread: m.labelIds?.includes("UNREAD") ?? false,
  };
}

export async function searchMail(userId: string, query: string, max = 10): Promise<MailSummary[]> {
  const list = await callGoogle<{ messages?: { id: string }[] }>(userId, READ, {
    url: MSG,
    query: { q: query, maxResults: Math.min(Math.max(max, 1), 20) },
  });
  const ids = (list.messages ?? []).map((m) => m.id);
  const messages = await Promise.all(
    ids.map((id) => {
      const url = new URL(`${MSG}/${encodeURIComponent(id)}`);
      url.searchParams.set("format", "metadata");
      for (const h of ["From", "To", "Subject", "Date"]) url.searchParams.append("metadataHeaders", h);
      return callGoogle<ApiMessage>(userId, READ, { url: url.toString() });
    }),
  );
  return messages.map(summarize);
}

function walk(part: Part | undefined, visit: (p: Part) => void): void {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

export async function readMail(userId: string, id: string): Promise<MailMessage> {
  const m = await callGoogle<ApiMessage>(userId, READ, { url: `${MSG}/${encodeURIComponent(id)}`, query: { format: "full" } });
  let plain = "";
  let html = "";
  const attachments: MailAttachment[] = [];
  walk(m.payload, (p) => {
    if (p.filename && p.body?.attachmentId) {
      attachments.push({ id: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType ?? "application/octet-stream", size: p.body.size ?? 0 });
      return;
    }
    const data = p.body?.data;
    if (!data) return;
    if (p.mimeType === "text/plain" && !plain) plain = decodeBase64Url(data).toString("utf8");
    else if (p.mimeType === "text/html" && !html) html = decodeBase64Url(data).toString("utf8");
  });
  return {
    ...summarize(m),
    cc: header(m, "Cc"),
    messageId: header(m, "Message-ID") || header(m, "Message-Id"),
    references: header(m, "References"),
    body: (plain || htmlToText(html)).trim(),
    attachments,
  };
}

export async function mailAttachment(userId: string, messageId: string, attachmentId: string): Promise<Buffer> {
  const res = await callGoogle<{ data?: string }>(userId, READ, {
    url: `${MSG}/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  });
  return decodeBase64Url(res.data ?? "");
}

export interface SendRequest extends OutgoingMail {
  threadId?: string | undefined;
}

export async function sendMail(userId: string, mail: SendRequest): Promise<{ id: string; threadId: string }> {
  const raw = Buffer.from(buildMime(mail), "utf8").toString("base64url");
  return callGoogle<{ id: string; threadId: string }>(userId, SEND, {
    method: "POST",
    url: `${MSG}/send`,
    json: { raw, ...(mail.threadId ? { threadId: mail.threadId } : {}) },
  });
}

export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

export function senderName(from: string): string {
  const name = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1];
  return (name ?? from).trim();
}
