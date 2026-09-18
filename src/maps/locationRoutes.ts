import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { getUser, sql } from "../db/index.js";
import { hasAccess } from "../payments/service.js";
import { LOCATION_LINK_MINUTES, readSignedToken } from "../uploads/links.js";
import { parsePoint } from "../wa/fonnte.js";
import { describeInbound, type Inbound } from "../wa/inbound.js";
import { pageShell, privatePageHeaders } from "../web/page.js";

/**
 * "Kirim lokasi saya" as a web page: the phone's browser asks for permission and posts its position here. It does
 * not depend on what the WhatsApp line forwards, so it works on the free Fonnte package and with live locations.
 * The position arrives as an ordinary location message, and the conversation carries on in WhatsApp.
 */

const SENDS_PER_HOUR = 20;

interface LocationRoutesOptions {
  onQueued: (userId: string) => void;
}

function page(state: "ask" | "expired"): string {
  if (state === "expired") {
    return pageShell(
      "Link sudah tidak berlaku",
      `<h1>Link sudah tidak berlaku</h1><p>Minta link baru di WhatsApp dengan mengetik <b>LOKASI</b>.</p>`,
    );
  }
  const body = `<h1>Kirim lokasi Anda</h1>
<p>Tekan tombol di bawah, lalu izinkan browser membaca lokasi. Lokasinya dikirim ke sekretaris Anda di WhatsApp, dan hanya dipakai untuk mencari tempat terdekat dan menunjukkan arah.</p>
<p><button id="go" type="button">Kirim lokasi saya</button></p>
<p id="out" role="status" aria-live="polite"></p>
<p>Link pribadi, berlaku ${LOCATION_LINK_MINUTES} menit. Jangan dibagikan.</p>`;
  const script = `
const go = document.getElementById("go"), out = document.getElementById("out");
go.addEventListener("click", () => {
  if (!navigator.geolocation) { out.textContent = "Browser ini tidak bisa membaca lokasi. Kirim lokasi lewat WhatsApp saja."; return; }
  go.disabled = true; out.textContent = "Mencari lokasi Anda...";
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const res = await fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }) });
      const data = await res.json().catch(() => ({}));
      out.textContent = data.message || (res.ok ? "Terkirim." : "Lokasi gagal dikirim. Coba lagi.");
      if (!res.ok) go.disabled = false;
    } catch { out.textContent = "Koneksi terputus. Coba lagi."; go.disabled = false; }
  }, (err) => {
    out.textContent = err.code === 1
      ? "Izin lokasi ditolak. Aktifkan izin lokasi untuk browser ini di pengaturan, lalu tekan tombolnya lagi."
      : "Lokasi belum terbaca. Pastikan GPS menyala, lalu coba lagi.";
    go.disabled = false;
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
});`;
  return pageShell("Kirim lokasi", body, script);
}

export const locationRoutes: FastifyPluginAsync<LocationRoutesOptions> = async (app, opts) => {
  app.get("/l/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const valid = readSignedToken("location", token);
    reply.headers(privatePageHeaders()).type("text/html; charset=utf-8");
    if (!valid) return reply.code(404).send(page("expired"));
    return page("ask");
  });

  app.post("/l/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const valid = readSignedToken("location", token);
    reply.headers(privatePageHeaders());
    if (!valid) return reply.code(404).send({ ok: false, message: "Link sudah tidak berlaku. Ketik LOKASI di WhatsApp untuk link baru." });
    const user = await getUser(valid.userId);
    if (!user || !hasAccess(user)) return reply.code(404).send({ ok: false, message: "Link sudah tidak berlaku." });

    const body = (req.body ?? {}) as { lat?: unknown; lng?: unknown };
    const point = parsePoint(`${Number(body.lat)},${Number(body.lng)}`);
    if (!point) return reply.code(400).send({ ok: false, message: "Lokasi tidak terbaca. Coba lagi." });

    const [recent] = await sql<{ n: string }[]>`
      select count(*) as n from messages
      where user_id = ${user.id} and wamid like 'location.%' and created_at > now() - interval '1 hour'
    `;
    if (Number(recent?.n ?? 0) >= SENDS_PER_HOUR) {
      return reply.code(429).send({ ok: false, message: "Terlalu sering. Coba lagi nanti." });
    }

    const inbound: Inbound = { kind: "location", latitude: point.lat, longitude: point.lng, name: "lokasi Anda saat ini" };
    await sql`
      insert into messages (user_id, wamid, direction, kind, body, payload)
      values (${user.id}, ${`location.${randomUUID()}`}, 'in', 'location', ${describeInbound(inbound)}, ${sql.json(inbound as never)})
    `;
    req.log.info({ userId: user.id }, "lokasi diterima lewat link");
    opts.onQueued(user.id);
    return { ok: true, message: `Terkirim. Kembali ke WhatsApp, sekretaris Anda sudah menerima lokasinya.` };
  });
};

