import { publicBaseUrl, readSignedToken } from "../uploads/links.js";

const URL_PATTERN = /https?:\/\/[^\s<>()"'`]+/gi;
const PAGE_PURPOSE: Record<string, string> = { u: "upload", connect: "google" };

export const INVENTED_LINK_NOTE = "(link itu tidak valid; ketik *FILE* untuk link kirim file atau *KONEKSI* untuk link Google)";

/**
 * Milo's own page links carry a signed token, so a real one can be told apart from one the model made up. Links on
 * other hosts that look like Milo's (e.g. "milo.id") are always made up: Milo only ever links to its own address.
 */
export function isInventedMiloLink(raw: string, base = publicBaseUrl()): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const baseHost = base ? new URL(base).host : undefined;
  if (baseHost && url.host === baseHost) {
    const page = /^\/(u|connect)\/([^/?#]+)/.exec(url.pathname);
    return page ? !readSignedToken(PAGE_PURPOSE[page[1]!]!, page[2]!) : false;
  }
  return url.hostname.split(".").some((label) => /^milo(\b|-|$)/i.test(label));
}

export function stripInventedLinks(text: string, base = publicBaseUrl()): { text: string; removed: string[] } {
  const removed: string[] = [];
  const cleaned = text.replace(URL_PATTERN, (match) => {
    const trailing = /[.,;:!?)\]*_~]+$/.exec(match)?.[0] ?? "";
    const url = match.slice(0, match.length - trailing.length);
    if (!isInventedMiloLink(url, base)) return match;
    removed.push(url);
    return `${INVENTED_LINK_NOTE}${trailing}`;
  });
  return { text: cleaned, removed };
}
