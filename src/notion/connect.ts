import type { FastifyPluginAsync } from "fastify";
import { getUser } from "../db/index.js";
import { hasAccess } from "../payments/service.js";
import { DEFAULT_ASSISTANT_NAME } from "../persona/catalog.js";
import { createSignedToken, publicBaseUrl, readSignedToken } from "../uploads/links.js";
import { formatDateTime } from "../util.js";
import { escapeHtml, pageShell, privatePageHeaders } from "../web/page.js";
import {
  beginNotionAuth,
  completeNotionAuth,
  NotionApiError,
  NotionStateError,
  notionEnabled,
  type NotionAuthResult,
} from "./client.js";

export const NOTION_CONNECT_MINUTES = 30;
const PURPOSE = "notion";

export function notionUrlFor(userId: string): string | undefined {
  const base = publicBaseUrl();
  if (!base || !notionEnabled()) return undefined;
  return `${base}/notion/${createSignedToken(PURPOSE, userId, NOTION_CONNECT_MINUTES * 60)}`;
}

function messagePage(title: string, body: string): string {
  return pageShell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`);
}

/**
 * The one thing this page exists to say: on Notion's own screen the user has to tick the pages and databases
 * Milo may touch. Nobody expects that, and a workspace connected with nothing ticked looks broken rather than
 * empty, so it is spelled out before they leave.
 */
function invitePage(opts: { assistantName: string; expiresText: string; token: string }): string {
  return pageShell(
    "Hubungkan Notion",
    `
<h1>Hubungkan Notion ke ${escapeHtml(opts.assistantName)}</h1>
<p>Di layar Notion berikutnya, <b>pilih halaman dan database yang boleh diakses</b>. Hanya yang Anda centang yang bisa dibaca dan ditulis; sisanya tetap tertutup.</p>
<ul>
  <li>Centang minimal satu halaman, kalau tidak ${escapeHtml(opts.assistantName)} tidak melihat apa pun.</li>
  <li>Halaman anak dari yang Anda centang ikut terbawa.</li>
  <li>Bisa diubah kapan saja dari menu <i>Connections</i> di Notion.</li>
</ul>
<p class="cta-row"><a class="btn btn-wa" href="/notion/${escapeHtml(opts.token)}/start">Lanjut ke Notion</a></p>
<p><small>Link pribadi, berlaku sampai ${escapeHtml(opts.expiresText)}. Jangan dibagikan.</small></p>`,
  );
}

interface NotionRoutesOptions {
  onConnected: (result: NotionAuthResult) => Promise<void>;
}

export const notionRoutes: FastifyPluginAsync<NotionRoutesOptions> = async (app, opts) => {
  const expired = messagePage("Link sudah tidak berlaku", "Ketik KONEKSI di WhatsApp untuk meminta link baru.");

  async function linkUser(token: string) {
    const link = readSignedToken(PURPOSE, token);
    if (!link) return undefined;
    const user = await getUser(link.userId);
    if (!user || user.state === "OPTED_OUT" || !hasAccess(user)) return undefined;
    return { user, expiresAt: link.expiresAt };
  }

  app.get("/notion/:token", async (req, reply) => {
    reply.headers(privatePageHeaders()).type("text/html; charset=utf-8");
    if (!notionEnabled()) return reply.code(404).send(messagePage("Belum tersedia", "Koneksi Notion belum diaktifkan."));
    const { token } = req.params as { token: string };
    if (token === "callback") return reply.callNotFound();
    const found = await linkUser(token);
    if (!found) return reply.code(404).send(expired);
    return invitePage({
      assistantName: found.user.assistantName ?? DEFAULT_ASSISTANT_NAME,
      expiresText: formatDateTime(found.expiresAt, found.user.timezone),
      token,
    });
  });

  app.get("/notion/:token/start", async (req, reply) => {
    reply.headers(privatePageHeaders("https://api.notion.com"));
    const { token } = req.params as { token: string };
    const found = notionEnabled() ? await linkUser(token) : undefined;
    if (!found) return reply.code(404).type("text/html; charset=utf-8").send(expired);
    try {
      return reply.redirect(await beginNotionAuth(found.user.id), 302);
    } catch (err) {
      req.log.warn({ err }, "tidak bisa memulai login Notion");
      return reply
        .code(503)
        .type("text/html; charset=utf-8")
        .send(messagePage("Belum bisa dihubungkan", "Alamat Milo belum siap. Coba lagi beberapa saat lagi."));
    }
  });

  app.get("/notion/callback", async (req, reply) => {
    reply.headers(privatePageHeaders()).type("text/html; charset=utf-8");
    const q = req.query as { state?: string; code?: string; error?: string };
    if (q.error) return messagePage("Dibatalkan", "Notion tidak jadi dihubungkan. Anda bisa mencoba lagi dari menu Koneksi di WhatsApp.");
    if (!q.state || !q.code) return reply.code(400).send(messagePage("Permintaan tidak lengkap", "Silakan mulai lagi dari WhatsApp."));
    try {
      const result = await completeNotionAuth(q.state, q.code);
      await opts.onConnected(result);
      const where = result.workspaceName ? ` (${result.workspaceName})` : "";
      return messagePage("Berhasil terhubung", `Notion terhubung${where}. Silakan kembali ke WhatsApp.`);
    } catch (err) {
      if (err instanceof NotionStateError) return reply.code(400).send(messagePage("Link sudah dipakai", err.message));
      req.log.warn({ err }, "login Notion gagal");
      const detail = err instanceof NotionApiError ? err.message : "Terjadi gangguan.";
      return reply.code(502).send(messagePage("Gagal terhubung", `${detail} Silakan coba lagi dari WhatsApp.`));
    }
  });
};
