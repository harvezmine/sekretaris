const escapeHtml = (s: string) =>
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
`;

const SCRIPT = `
  const form = document.getElementById("f");
  const input = document.getElementById("files");
  const note = document.getElementById("note");
  const list = document.getElementById("list");
  const btn = document.getElementById("send");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const files = Array.from(input.files || []);
    if (!files.length) { input.focus(); return; }
    btn.disabled = true;
    for (const [i, file] of files.entries()) {
      const li = document.createElement("li");
      li.textContent = file.name + " — mengirim…";
      list.appendChild(li);
      if (file.size > MAX_BYTES) { li.textContent = file.name + " — terlalu besar"; li.className = "bad"; continue; }
      const caption = i === files.length - 1 ? note.value.trim() : "";
      try {
        const res = await fetch(location.pathname, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "x-filename": encodeURIComponent(file.name),
            "x-caption": encodeURIComponent(caption),
          },
          body: file,
        });
        const out = await res.json().catch(() => ({ message: "Gagal (" + res.status + ")" }));
        li.textContent = file.name + " — " + (out.message || (res.ok ? "terkirim" : "gagal"));
        li.className = res.ok ? "ok" : "bad";
      } catch {
        li.textContent = file.name + " — koneksi terputus, coba lagi";
        li.className = "bad";
      }
    }
    input.value = "";
    note.value = "";
    btn.disabled = false;
  });
`;

export function uploadPage(
  opts: { expired: true } | { expired?: false; assistantName: string; expiresText: string; maxMb: number },
): string {
  const head = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Kirim file</title><style>${STYLE}</style></head><body><main>`;
  if (opts.expired) {
    return `${head}<h1>Link sudah tidak berlaku</h1><p>Ketik <b>FILE</b> di WhatsApp untuk meminta link baru.</p></main></body></html>`;
  }
  const name = escapeHtml(opts.assistantName);
  return `${head}
<h1>Kirim file ke ${name}</h1>
<p>File yang Anda kirim di sini tersimpan seperti file yang dikirim di WhatsApp. Jawabannya muncul di WhatsApp.</p>
<form id="f" class="card">
  <label class="drop">PDF, Word, teks, foto, atau rekaman suara (maks. ${opts.maxMb} MB)
    <input id="files" type="file" multiple accept=".pdf,.docx,.txt,.csv,.md,image/jpeg,image/png,image/webp,image/gif,.mp3,.m4a,.ogg,.opus">
  </label>
  <label for="note">Pertanyaan tentang file ini <small>(opsional)</small></label>
  <textarea id="note" maxlength="1000" placeholder="Misalnya: poin pentingnya apa?"></textarea>
  <button id="send" type="submit">Kirim</button>
  <ul id="list" aria-live="polite"></ul>
</form>
<p style="margin-top:16px"><small>Link pribadi, berlaku sampai ${escapeHtml(opts.expiresText)}. Jangan dibagikan.</small></p>
</main><script>const MAX_BYTES = ${opts.maxMb * 1024 * 1024};${SCRIPT}</script></body></html>`;
}
