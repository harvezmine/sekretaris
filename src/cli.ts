import { createHmac } from "node:crypto";
import { parseArgs } from "node:util";
import { listUsers, usageReport } from "./admin/reports.js";
import { migrate, sql } from "./db/index.js";
import { createCodes } from "./onboarding/codes.js";
import { BTN } from "./onboarding/copy.js";
import { CHECKS, describeLogSource, describeServer, logCheckFor, runCheck, type Check } from "./servers/checks.js";
import { adminNumbers, allApps, findApp, findServer, registry } from "./servers/registry.js";

const HELP = `Milo CLI

  code <trial|pendiri> [--count N] [--uses N] [--days N] [--expires N] [--source TEKS] [--prefix TEKS]
      Buat kode undangan. --days hanya untuk trial (default TRIAL_DAYS). --expires: kode kedaluwarsa (hari, default 30).
  usage [--days N]      Laporan pemakaian & biaya (default 7 hari).
  users                 Daftar pengguna terbaru.
  paid <provider_ref>   Tandai pembayaran lunas lewat server yang sedang berjalan (butuh ADMIN_TOKEN & PORT).
  servers               Daftar server yang bisa dicek Milo dan jumlah nomor admin.
  server <nama> <cek> [target|url] [--lines N]
                        Jalankan satu cek server persis seperti yang dilakukan Milo.
                        Cek: ${CHECKS.join(", ")}.
  app-logs <server/app> [--lines N] [--errors]
                        Baca log aplikasi seperti yang dilakukan Milo.

  Simulasi pesan masuk (format mengikuti WA_PROVIDER; dengan WA_DRY_RUN=true balasan muncul di log app):
  say <nomor> <teks>    Kirim pesan teks seolah-olah dari nomor itu.
  tap <nomor> <id>      Tekan tombol (code, price, faq, subscribe, executive, resend_qr, cancel_pay, delete_yes, delete_no).
                        Di Fonnte, ini mengirim judul tombolnya — sama seperti pengguna membalas menu.
`;

async function postFonnte(from: string, message: string): Promise<void> {
  const secret = process.env.FONNTE_WEBHOOK_SECRET ?? "";
  const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? "3000"}/fonnte/webhook/${secret}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device: "simulasi",
      sender: from,
      name: "Simulasi",
      message,
      timestamp: Math.floor(Date.now() / 1000) + Math.random(),
    }),
  });
  console.log(res.status, await res.text());
}

async function postWebhook(from: string, message: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "simulasi",
        changes: [
          {
            field: "messages",
            value: {
              contacts: [{ wa_id: from, profile: { name: "Simulasi" } }],
              messages: [{ id: `wamid.sim.${Date.now()}`, from, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
            },
          },
        ],
      },
    ],
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.WA_APP_SECRET) {
    headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", process.env.WA_APP_SECRET).update(payload).digest("hex")}`;
  }
  const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? "3000"}/wa/webhook`, { method: "POST", headers, body: payload });
  console.log(res.status, await res.text());
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      count: { type: "string" },
      uses: { type: "string" },
      days: { type: "string" },
      expires: { type: "string" },
      source: { type: "string" },
      prefix: { type: "string" },
      lines: { type: "string" },
      errors: { type: "boolean" },
    },
  });

  switch (command) {
    case "code": {
      await migrate();
      const kind = positionals[0];
      if (kind !== "trial" && kind !== "pendiri") throw new Error("jenis kode harus trial atau pendiri");
      const codes = await createCodes({
        kind,
        count: Number(values.count ?? 1),
        maxUses: Number(values.uses ?? 1),
        trialDays: values.days ? Number(values.days) : undefined,
        expiresInDays: Number(values.expires ?? 30),
        source: values.source,
        prefix: values.prefix,
      });
      for (const c of codes) console.log(c.code);
      break;
    }
    case "usage": {
      const report = await usageReport(Number(values.days ?? 7));
      console.log(`Sejak ${report.since.toISOString()}`);
      console.table(
        report.rows.map((r) => ({
          user: r.displayName ?? r.waId,
          model: r.model,
          plan: r.plan,
          pesan: r.inboundMessages,
          giliran: r.agentRuns,
          "pesan/giliran": r.messagesPerRun,
          "ringan/sedang/berat": `${r.runsLight}/${r.runsMedium}/${r.runsHeavy}`,
          "latensi ms": r.avgLatencyMs,
          "$/giliran": r.costPerRunUsd,
          "porsi cache": r.cacheReadShare,
          "total $": r.totalCostUsd,
        })),
      );
      console.log("\nPer model:");
      console.table(
        report.byModel.map((m) => ({
          model: m.model,
          pengguna: m.users,
          giliran: m.agentRuns,
          gagal: m.failedRuns,
          "ringan/sedang/berat": `${m.shareLight ?? "-"}/${m.shareMedium ?? "-"}/${m.shareHeavy ?? "-"}`,
          "latensi ms": m.avgLatencyMs,
          "$/giliran": m.costPerRunUsd,
          "porsi cache": m.cacheReadShare,
          "total $": m.llmCostUsd,
        })),
      );
      console.log(report.totals);
      break;
    }
    case "users":
      console.table(await listUsers(50));
      break;
    case "paid": {
      const ref = positionals[0];
      if (!ref) throw new Error("sertakan provider_ref");
      const port = process.env.PORT ?? "3000";
      const res = await fetch(`http://127.0.0.1:${port}/admin/payments/${encodeURIComponent(ref)}/paid`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN ?? ""}` },
      });
      console.log(res.status, await res.text());
      break;
    }
    case "servers": {
      const { servers, problems } = registry();
      for (const server of servers) {
        console.log(`${describeServer(server)}  ${server.description}`);
        if (server.kind === "ssh") {
          for (const app of server.apps) console.log(`  aplikasi ${app.id}: log dari ${describeLogSource(app.logs)}`);
        }
      }
      if (!servers.length) console.log("Belum ada server. Isi DOCKER_PROXY_URL dan/atau servers/servers.json.");
      for (const p of problems) console.log(`MASALAH: ${p}`);
      console.log(`Nomor admin terdaftar: ${adminNumbers().size}`);
      const [row] = await sql<{ users: string; servers: string }[]>`
        select count(distinct user_id) as users, count(*) as servers from user_servers
      `;
      console.log(`Server milik pengguna: ${row?.servers ?? 0} dari ${row?.users ?? 0} pengguna (SERVER_ACCESS=${process.env.SERVER_ACCESS ?? "admin"})`);
      break;
    }
    case "server": {
      const [name, check, arg] = positionals;
      if (!name || !check) throw new Error("pakai: server <nama> <cek> [target|url] [--lines N]");
      if (!(CHECKS as readonly string[]).includes(check)) throw new Error(`cek tidak dikenal: ${check}. Pilihan: ${CHECKS.join(", ")}`);
      const server = findServer(name);
      if (!server) throw new Error(`server tidak terdaftar: ${name}`);
      const isUrl = arg ? /^https?:\/\//.test(arg) : false;
      console.log(
        await runCheck(server, {
          check: check as Check,
          target: isUrl ? undefined : arg,
          url: isUrl ? arg : undefined,
          lines: values.lines ? Number(values.lines) : undefined,
        }),
      );
      break;
    }
    case "app-logs": {
      const [id] = positionals;
      if (!id) throw new Error(`pakai: app-logs <server/app> [--lines N] [--errors]. Terdaftar: ${allApps().map((a) => a.id).join(", ") || "-"}`);
      const found = findApp(id);
      if (!found) throw new Error(`aplikasi tidak terdaftar: ${id}`);
      console.log(
        await runCheck(found.server, {
          ...logCheckFor(found.app),
          lines: values.lines ? Number(values.lines) : undefined,
          onlyErrors: values.errors ?? false,
        }),
      );
      break;
    }
    case "say": {
      const [from, ...words] = positionals;
      if (!from || !words.length) throw new Error("pakai: say <nomor> <teks>");
      if (process.env.WA_PROVIDER === "fonnte") await postFonnte(from, words.join(" "));
      else await postWebhook(from, { type: "text", text: { body: words.join(" ") } });
      break;
    }
    case "tap": {
      const [from, id] = positionals;
      if (!from || !id) throw new Error("pakai: tap <nomor> <id-tombol>");
      if (process.env.WA_PROVIDER === "fonnte") {
        const button = Object.values(BTN).find((b) => b.id === id);
        if (!button) throw new Error(`tombol tidak dikenal: ${id}`);
        await postFonnte(from, button.title);
      } else {
        await postWebhook(from, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } });
      }
      break;
    }
    default:
      console.log(HELP);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
