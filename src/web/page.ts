/** Shared look for the few web pages Milo serves (file upload, Google connect). */

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
  :root { --bg:#f6f5f2; --card:#fff; --ink:#1d1d1b; --muted:#6b6a66; --line:#e3e1dc; --accent:#128c4a; --accent-ink:#fff; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#141413; --card:#1e1e1c; --ink:#f2f1ed; --muted:#a3a19b; --line:#34332f; --accent:#25b566; --accent-ink:#0b0b0a; --bad:#ff8a80; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:520px; margin:0 auto; padding:32px 16px 48px; }
  h1 { font-size:1.35rem; margin:0 0 4px; }
  p { margin:0 0 16px; color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; }
  label { display:block; font-weight:600; margin:0 0 6px; }
  .drop { display:block; border:1.5px dashed var(--line); border-radius:12px; padding:22px 16px; text-align:center; cursor:pointer; margin-bottom:16px; }
  .drop:focus-within { border-color:var(--accent); }
  .drop input { display:block; margin:10px auto 0; max-width:100%; }
  textarea { width:100%; min-height:84px; border:1px solid var(--line); border-radius:10px; padding:10px; font:inherit; background:transparent; color:inherit; resize:vertical; }
  button { margin-top:16px; width:100%; border:0; border-radius:10px; padding:13px; font:inherit; font-weight:600; background:var(--accent); color:var(--accent-ink); cursor:pointer; }
  button:disabled { opacity:.55; cursor:default; }
  ul { list-style:none; padding:0; margin:16px 0 0; }
  li { padding:8px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; }
  .ok { color:var(--accent); } .bad { color:var(--bad); }
  small { color:var(--muted); }
  .check { display:flex; gap:12px; align-items:flex-start; font-weight:500; padding:12px 0; border-top:1px solid var(--line); margin:0; }
  .check:first-of-type { border-top:0; }
  .check input { margin-top:5px; width:18px; height:18px; accent-color:var(--accent); }
  .check span small { display:block; font-weight:400; }
`;

export function pageShell(title: string, body: string, script?: string): string {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

/** For pages behind a personal link: nothing cached, nothing leaked through the Referer header. */
export function privatePageHeaders(extraFormAction = ""): Record<string, string> {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'${extraFormAction ? ` ${extraFormAction}` : ""}; frame-ancestors 'none'`,
  };
}
