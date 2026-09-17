/** Turning a web page or an HTML email into plain text: no browser, no DOM, just the readable parts. */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Keeps paragraph breaks and list bullets, drops markup, scripts and styles. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head|noscript|svg|template)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export function pageTitle(html: string): string {
  const raw = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html)?.[1];
  return raw ? decodeEntities(raw).replace(/\s+/g, " ").trim() : "";
}

/** Menus, headers and footers repeat on every page and crowd out the part worth reading. */
export function readableText(html: string): string {
  const stripped = html.replace(/<(nav|header|footer|aside|form|dialog)[\s\S]*?<\/\1>/gi, "");
  const main = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(stripped)?.[1] ?? /<main[^>]*>([\s\S]*?)<\/main>/i.exec(stripped)?.[1];
  const body = main ?? /<body[^>]*>([\s\S]*)<\/body>/i.exec(stripped)?.[1] ?? stripped;
  const text = htmlToText(body);
  return text.length >= 200 || !main ? text : htmlToText(stripped);
}
