import { createHash, createHmac } from "node:crypto";
import { config } from "../config.js";
import { safeEqual } from "../wa/verify.js";

/** Signed, expiring link that lets one user send files through the browser when WhatsApp cannot deliver them. */

function signingKey(): Buffer {
  return createHash("sha256").update(`milo-upload-link:${config.ADMIN_TOKEN}`).digest();
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url").slice(0, 32);
}

export function createUploadToken(userId: string, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + config.UPLOAD_LINK_HOURS * 3600;
  const payload = `${userId}.${expires.toString(36)}`;
  return `${payload}.${sign(payload)}`;
}

export function readUploadToken(token: string, now = Date.now()): { userId: string; expiresAt: Date } | undefined {
  const match = /^(\d{1,18})\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]{32})$/.exec(token);
  if (!match) return undefined;
  const [, userId, expiresRaw, signature] = match;
  if (!safeEqual(signature!, sign(`${userId}.${expiresRaw}`))) return undefined;
  const expiresAt = new Date(parseInt(expiresRaw!, 36) * 1000);
  if (expiresAt.getTime() <= now) return undefined;
  return { userId: userId!, expiresAt };
}

let seenBaseUrl: string | undefined;

/**
 * A quick tunnel gets a new hostname on every restart, so when PUBLIC_BASE_URL is empty the address is taken from
 * the host that the last webhook arrived on.
 */
export function rememberPublicHost(hostname: string | undefined): void {
  if (!hostname || config.PUBLIC_BASE_URL) return;
  const host = hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || host.endsWith(".local") || host.endsWith(".internal")) return;
  seenBaseUrl = `https://${host}`;
}

export function publicBaseUrl(): string | undefined {
  return config.PUBLIC_BASE_URL.replace(/\/+$/, "") || seenBaseUrl;
}

export function uploadUrlFor(userId: string): string | undefined {
  const base = publicBaseUrl();
  return base ? `${base}/u/${createUploadToken(userId)}` : undefined;
}

/** Whether files sent inside WhatsApp reach Milo on this line. */
export function directAttachments(): boolean {
  return config.WA_PROVIDER === "meta" || config.FONNTE_ATTACHMENTS;
}

export function resetSeenBaseUrl(): void {
  seenBaseUrl = undefined;
}
