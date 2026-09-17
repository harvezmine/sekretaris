import path from "node:path";
import { availableModels } from "./agent/providers.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { migrate, sql } from "./db/index.js";
import { enabledServices, googleEnabled, redirectUri } from "./google/client.js";
import { adminNumbers, registry } from "./servers/registry.js";
import { CloudApiClient, DryRunClient, type WhatsApp } from "./wa/client.js";
import { FonnteClient } from "./wa/fonnte.js";

async function main(): Promise<void> {
  await migrate();
  if (!availableModels().length) {
    console.warn("PERINGATAN: belum ada API key untuk model mana pun di MILO_MODELS/MILO_MODEL. Onboarding jalan, tapi agent akan gagal.");
  }

  const wa: WhatsApp = config.WA_DRY_RUN
    ? new DryRunClient(
        path.resolve(config.DATA_DIR, "dry-run"),
        (e) =>
          console.log(
            `[dry-run ${config.WA_PROVIDER} → ${e.to}] ${e.type}${e.template ? `:${e.template}` : ""}${e.text ? `\n${e.text}` : ""}${e.buttons && e.type === "buttons" ? `\n  [${e.buttons.map((b) => b.title).join("] [")}]` : ""}${e.file ? `\n  file: ${e.file}` : ""}`,
          ),
        config.WA_PROVIDER,
      )
    : config.WA_PROVIDER === "fonnte"
      ? new FonnteClient({ token: config.FONNTE_TOKEN, typing: config.FONNTE_TYPING })
      : new CloudApiClient({
          phoneNumberId: config.WA_PHONE_NUMBER_ID,
          accessToken: config.WA_ACCESS_TOKEN,
          graphVersion: config.WA_GRAPH_VERSION,
        });

  const { app, scheduler, debouncer } = await buildApp({ wa });
  if (config.WA_PROVIDER === "fonnte") {
    const base = config.PUBLIC_BASE_URL || "https://<alamat-publik>";
    app.log.info(`Webhook Fonnte: ${base.replace(/\/$/, "")}/fonnte/webhook/<FONNTE_WEBHOOK_SECRET>`);
  }
  if (googleEnabled()) {
    const redirect = redirectUri();
    app.log.info({ services: enabledServices(), redirect: redirect ?? null }, "koneksi Google aktif");
    if (!config.PUBLIC_BASE_URL && !config.GOOGLE_REDIRECT_URL) {
      app.log.warn("PUBLIC_BASE_URL kosong: login Google butuh alamat tetap yang terdaftar di Google Cloud Console");
    }
  } else if (config.GOOGLE_CLIENT_ID) {
    app.log.warn("GOOGLE_CLIENT_ID diisi, tapi koneksi Google belum aktif (cek GOOGLE_CLIENT_SECRET, SERVER_KEY_SECRET, GOOGLE_SERVICES)");
  }
  const servers = registry();
  for (const problem of servers.problems) app.log.warn(`Konfigurasi server: ${problem}`);
  if (servers.servers.length) {
    app.log.info(
      { servers: servers.servers.map((s) => s.name), admins: adminNumbers().size },
      adminNumbers().size ? "akses server aktif untuk nomor admin" : "server terdaftar, tapi SERVER_ADMIN_NUMBERS kosong",
    );
  }
  await scheduler.start();
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  app.log.info(
    { dryRun: config.WA_DRY_RUN, payment: config.PAYMENT_MODE, models: availableModels(), effort: config.MILO_EFFORT },
    "Milo siap",
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "berhenti…");
    scheduler.stop();
    await app.close();
    await debouncer.drain();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
