import { escapeHtml, pageShell } from "../web/page.js";

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
  if (opts.expired) {
    return pageShell("Kirim file", `<h1>Link sudah tidak berlaku</h1><p>Ketik <b>FILE</b> di WhatsApp untuk meminta link baru.</p>`);
  }
  const name = escapeHtml(opts.assistantName);
  return pageShell(
    "Kirim file",
    `
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
<p style="margin-top:16px"><small>Link pribadi, berlaku sampai ${escapeHtml(opts.expiresText)}. Jangan dibagikan.</small></p>`,
    `const MAX_BYTES = ${opts.maxMb * 1024 * 1024};${SCRIPT}`,
  );
}
