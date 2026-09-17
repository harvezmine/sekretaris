/** Just enough RFC 5322 / MIME to send a plain-text email through the Gmail API. */

const ADDRESS = /^(?:"?[^"<>\r\n]{0,100}"?\s*<)?[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}>?$/;

export function validAddress(address: string): boolean {
  const a = address.trim();
  if (!ADDRESS.test(a)) return false;
  return a.includes("<") === a.includes(">");
}

export function bareAddress(address: string): string {
  return (/<([^>]+)>/.exec(address)?.[1] ?? address).trim().toLowerCase();
}

function isPlainAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c > 126) return false;
  }
  return true;
}

/** RFC 2047 encoded-word for non-ASCII header text; line breaks are removed so headers cannot be injected. */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  return isPlainAscii(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function wrap(base64: string): string {
  return base64.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

export interface OutgoingMail {
  to: string[];
  cc?: string[] | undefined;
  subject: string;
  body: string;
  inReplyTo?: string | undefined;
  references?: string | undefined;
}

export function buildMime(mail: OutgoingMail): string {
  for (const a of [...mail.to, ...(mail.cc ?? [])]) {
    if (!validAddress(a)) throw new Error(`alamat email tidak valid: ${a}`);
  }
  const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
  const headers = [
    `To: ${mail.to.map(oneLine).join(", ")}`,
    ...(mail.cc?.length ? [`Cc: ${mail.cc.map(oneLine).join(", ")}`] : []),
    `Subject: ${encodeHeader(mail.subject)}`,
    ...(mail.inReplyTo ? [`In-Reply-To: ${oneLine(mail.inReplyTo)}`] : []),
    ...(mail.references ? [`References: ${oneLine(mail.references)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = wrap(Buffer.from(mail.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64"));
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data, "base64url");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Good enough for reading an HTML-only email: keeps paragraph breaks, drops markup, styles and scripts. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
