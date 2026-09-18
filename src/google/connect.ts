import type { FastifyPluginAsync } from "fastify";
import { config } from "../config.js";
import { getUser } from "../db/index.js";
import { hasAccess } from "../payments/service.js";
import { DEFAULT_ASSISTANT_NAME } from "../persona/catalog.js";
import { createSignedToken, publicBaseUrl, readSignedToken } from "../uploads/links.js";
import { formatDateTime } from "../util.js";
import { escapeHtml, pageShell, privatePageHeaders } from "../web/page.js";
import {
  beginAuth,
  completeAuth,
  enabledServices,
  googleEnabled,
  GoogleApiError,
  OAuthStateError,
  SERVICE_LABEL,
  type AuthResult,
  type GoogleService,
} from "./client.js";

export const CONNECT_MINUTES = 30;
const PURPOSE = "google";

export function connectUrlFor(userId: string, services?: readonly GoogleService[]): string | undefined {
  const base = publicBaseUrl();
  if (!base || !googleEnabled()) return undefined;
  const token = createSignedToken(PURPOSE, userId, CONNECT_MINUTES * 60);
  const wanted = services?.length ? services.filter((s) => enabledServices().includes(s)) : enabledServices();
  return `${base}/connect/${token}?s=${wanted.join(",")}`;
}

export function parseServices(value: unknown): GoogleService[] {
  const raw = (Array.isArray(value) ? value : [value]).flatMap((v) => (typeof v === "string" ? v.split(",") : []));
  const wanted = new Set(raw.map((s) => s.trim().toLowerCase()));
  return enabledServices().filter((s) => wanted.has(s));
}

function serviceDetail(service: GoogleService): string {
  switch (service) {
    case "calendar":
      return "Lihat agenda, cari waktu kosong, buat acara. Undangan ke orang lain dikirim setelah Anda setujui.";
    case "gmail":
      return config.GOOGLE_GMAIL_READ
        ? "Cari, baca, dan ringkas email. Email dikirim atau dibalas hanya setelah Anda setujui."
        : "Kirim email atas nama Anda, hanya setelah Anda setujui.";
    case "drive":
      return config.GOOGLE_DRIVE_FULL
        ? "Cari dan baca dokumen di Drive, dan simpan file dari WhatsApp ke folder Milo."
        : "Simpan file dari WhatsApp ke folder Milo di Drive, dan baca file yang dibuat Milo.";
    case "contacts":
      return "Cari nomor dan email orang dari kontak Google Anda, jadi Anda tidak perlu mengetik nomornya. Hanya dibaca, tidak diubah.";
  }
}

const EMOJI: Record<GoogleService, string> = { calendar: "📅", gmail: "📧", drive: "📁", contacts: "👤" };

function connectPage(opts: { assistantName: string; expiresText: string; token: string; selected: GoogleService[]; note?: string }): string {
  const rows = enabledServices()
    .map(
      (s) => `<label class="check"><input type="checkbox" name="s" value="${s}"${opts.selected.includes(s) ? " checked" : ""}>
  <span>${EMOJI[s]} ${escapeHtml(SERVICE_LABEL[s])}<small>${escapeHtml(serviceDetail(s))}</small></span></label>`,
    )
    .join("\n");
  return pageShell(
    "Hubungkan Google",
    `
<h1>Hubungkan Google ke ${escapeHtml(opts.assistantName)}</h1>
<p>Pilih yang ingin dihubungkan, lalu masuk dengan akun Google Anda. Password Anda tidak pernah terlihat oleh kami.</p>
${opts.note ? `<p class="bad">${escapeHtml(opts.note)}</p>` : ""}
<form class="card" method="get" action="/connect/${escapeHtml(opts.token)}/start">
${rows}
<button type="submit">Masuk dengan Google</button>
</form>
<p style="margin-top:16px"><small>Di halaman Google, centang <b>semua</b> izin yang diminta. Selama masa uji coba, Google bisa menampilkan peringatan “Google belum memverifikasi aplikasi ini”: pilih <b>Lanjutan</b>, lalu <b>Lanjutkan</b>.</small></p>
<p><small>Akses bisa dicabut kapan saja lewat menu <b>Koneksi</b> di WhatsApp atau di myaccount.google.com/permissions. Link ini pribadi dan berlaku sampai ${escapeHtml(opts.expiresText)}.</small></p>`,
  );
}

function messagePage(title: string, text: string): string {
  return pageShell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`);
}

export interface GoogleRoutesOptions {
  onConnected: (result: AuthResult) => Promise<void>;
}

export const googleRoutes: FastifyPluginAsync<GoogleRoutesOptions> = async (app, opts) => {
  async function linkUser(token: string) {
    const link = readSignedToken(PURPOSE, token);
    if (!link) return undefined;
    const user = await getUser(link.userId);
    if (!user || user.state === "OPTED_OUT" || !hasAccess(user)) return undefined;
    return { user, expiresAt: link.expiresAt };
  }

  const expired = messagePage("Link sudah tidak berlaku", "Ketik KONEKSI di WhatsApp untuk meminta link baru.");

  app.get("/connect/:token", async (req, reply) => {
    reply.headers(privatePageHeaders("https://accounts.google.com")).type("text/html; charset=utf-8");
    if (!googleEnabled()) return reply.code(404).send(messagePage("Belum tersedia", "Koneksi Google belum diaktifkan."));
    const { token } = req.params as { token: string };
    const found = await linkUser(token);
    if (!found) return reply.code(404).send(expired);
    const selected = parseServices((req.query as { s?: unknown }).s);
    return connectPage({
      assistantName: found.user.assistantName ?? DEFAULT_ASSISTANT_NAME,
      expiresText: formatDateTime(found.expiresAt, found.user.timezone),
      token,
      selected: selected.length ? selected : enabledServices(),
    });
  });

  app.get("/connect/:token/start", async (req, reply) => {
    reply.headers(privatePageHeaders("https://accounts.google.com"));
    const { token } = req.params as { token: string };
    const found = googleEnabled() ? await linkUser(token) : undefined;
    if (!found) return reply.code(404).type("text/html; charset=utf-8").send(expired);
    const services = parseServices((req.query as { s?: unknown }).s);
    if (!services.length) {
      return reply.type("text/html; charset=utf-8").send(
        connectPage({
          assistantName: found.user.assistantName ?? DEFAULT_ASSISTANT_NAME,
          expiresText: formatDateTime(found.expiresAt, found.user.timezone),
          token,
          selected: [],
          note: "Pilih minimal satu yang ingin dihubungkan.",
        }),
      );
    }
    try {
      return reply.redirect(await beginAuth(found.user.id, services), 302);
    } catch (err) {
      req.log.warn({ err }, "tidak bisa memulai login Google");
      return reply.code(503).type("text/html; charset=utf-8").send(messagePage("Belum bisa dihubungkan", "Alamat Milo belum siap. Coba lagi beberapa saat lagi."));
    }
  });

  app.get("/google/callback", async (req, reply) => {
    reply.headers(privatePageHeaders()).type("text/html; charset=utf-8");
    const q = req.query as { state?: string; code?: string; error?: string };
    if (q.error) {
      return messagePage("Dibatalkan", "Akun Google tidak jadi dihubungkan. Anda bisa mencoba lagi dari menu Koneksi di WhatsApp.");
    }
    if (!q.state || !q.code) return reply.code(400).send(messagePage("Permintaan tidak lengkap", "Silakan mulai lagi dari WhatsApp."));
    try {
      const result = await completeAuth(q.state, q.code);
      await opts.onConnected(result);
      const who = result.email ? ` sebagai ${result.email}` : "";
      return messagePage("Berhasil terhubung", `Google terhubung${who}. Silakan kembali ke WhatsApp.`);
    } catch (err) {
      if (err instanceof OAuthStateError) return reply.code(400).send(messagePage("Link sudah dipakai", err.message));
      req.log.warn({ err }, "login Google gagal");
      const detail = err instanceof GoogleApiError ? err.message : "Terjadi gangguan.";
      return reply.code(502).send(messagePage("Gagal terhubung", `${detail} Silakan coba lagi dari WhatsApp.`));
    }
  });
};
