import Fastify, { type FastifyInstance } from "fastify";
import { adminRoutes } from "./admin/routes.js";
import { availableModels } from "./agent/providers.js";
import { Agent } from "./agent/run.js";
import { config } from "./config.js";
import { sql } from "./db/index.js";
import { Debouncer } from "./debounce.js";
import { createProvider, Payments } from "./payments/service.js";
import type { PaymentProvider } from "./payments/provider.js";
import { Pipeline } from "./pipeline.js";
import { googleRoutes } from "./google/connect.js";
import { notionRoutes } from "./notion/connect.js";
import { Scheduler } from "./reminders/scheduler.js";
import { rememberPublicHost } from "./uploads/links.js";
import { uploadRoutes } from "./uploads/routes.js";
import { locationRoutes } from "./maps/locationRoutes.js";
import type { Button, WhatsApp } from "./wa/client.js";
import { fonnteFieldsPresent, parseFonnteWebhook } from "./wa/fonnte.js";
import { describeInbound, parseWebhook, type Inbound, type InboundMessage } from "./wa/inbound.js";
import { matchMenuReply } from "./wa/menu.js";
import { Outbox } from "./wa/outbox.js";
import { safeEqual, verifySignature } from "./wa/verify.js";
import type { UserRow } from "./db/index.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface AppDeps {
  wa: WhatsApp;
  agent?: Agent;
  paymentProvider?: PaymentProvider;
  logger?: boolean | object;
}

export interface App {
  app: FastifyInstance;
  pipeline: Pipeline;
  debouncer: Debouncer;
  payments: Payments;
  scheduler: Scheduler;
  outbox: Outbox;
}

export async function buildApp(deps: AppDeps): Promise<App> {
  const app = Fastify({
    logger: deps.logger ?? { level: config.LOG_LEVEL },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });
  const log = app.log;

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    const raw = body as Buffer;
    req.rawBody = raw;
    if (raw.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(raw.toString("utf8")));
    } catch {
      const err = new Error("JSON tidak valid") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  const outbox = new Outbox(deps.wa);
  const payments = new Payments(deps.paymentProvider ?? createProvider(), outbox, log);
  const agent = deps.agent ?? new Agent(log);
  const pipeline = new Pipeline({ wa: deps.wa, outbox, payments, agent, log });
  payments.onActivated = (user, message) => pipeline.afterActivation(user, message);
  const debouncer = new Debouncer(
    config.MILO_DEBOUNCE_MS,
    (userId) => pipeline.process(userId),
    (userId, err) => log.error({ err, userId }, "debounce handler gagal"),
  );
  const scheduler = new Scheduler(outbox, log, payments, agent);

  /** A plain "oke" hours later is conversation, not consent; a question only counts while it is still the open one. */
  const ANSWER_WINDOW_MINUTES = 60;

  /** On channels without buttons, an answer in words to the question Milo just asked becomes that choice. */
  async function asButton(userId: string, inbound: Inbound): Promise<Inbound> {
    if (deps.wa.supportsButtons || inbound.kind !== "text") return inbound;
    const [last] = await sql<{ kind: string; payload: { buttons?: Button[] } | null; answered: boolean; ageMinutes: number }[]>`
      select
        m.kind,
        m.payload,
        exists (select 1 from messages r where r.user_id = m.user_id and r.direction = 'in' and r.id > m.id) as answered,
        extract(epoch from now() - m.created_at) / 60 as age_minutes
      from messages m
      where m.user_id = ${userId} and m.direction = 'out'
      order by m.id desc limit 1
    `;
    const buttons = last?.kind === "interactive" && !last.answered ? last.payload?.buttons : undefined;
    const hit = buttons ? matchMenuReply(inbound.text, buttons) : undefined;
    if (!hit) return inbound;
    // Naming the choice stands on its own; a bare yes or no only means this question while it is fresh.
    const bare = hit.answer && !comparableSame(inbound.text, hit);
    if (bare && Number(last!.ageMinutes) > ANSWER_WINDOW_MINUTES) return inbound;
    return { kind: "button", id: hit.id, title: hit.title };
  }

  function comparableSame(text: string, button: Button): boolean {
    const norm = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    const key = norm(text);
    return [button.title, ...(button.say ?? [])].some((c) => key.startsWith(norm(c)));
  }

  async function ingest(messages: InboundMessage[]): Promise<void> {
    for (const m of messages) {
      const [user] = await sql<UserRow[]>`
        insert into users (wa_id, display_name, timezone)
        values (${m.from}, ${m.profileName ?? null}, ${config.DEFAULT_TIMEZONE})
        on conflict (wa_id) do update set display_name = coalesce(users.display_name, excluded.display_name)
        returning *
      `;
      if (!user) continue;
      const inbound = await asButton(user.id, m.inbound);
      const inserted = await sql`
        insert into messages (user_id, wamid, direction, kind, body, payload)
        values (${user.id}, ${m.wamid}, 'in', ${inbound.kind}, ${describeInbound(inbound)}, ${sql.json(inbound as never)})
        on conflict (wamid) do nothing
        returning id
      `;
      if (!inserted.length) {
        log.info({ wamid: m.wamid, userId: user.id }, "pesan masuk diabaikan karena duplikat");
        continue;
      }
      await sql`
        update users set last_inbound_at = greatest(coalesce(last_inbound_at, to_timestamp(0)), ${m.timestamp})
        where id = ${user.id}
      `;
      const conversational = user.state === "READY" && inbound.kind !== "button";
      if (conversational) void outbox.typing(m.wamid);
      debouncer.poke(user.id, conversational ? config.MILO_DEBOUNCE_MS : 300);
    }
  }

  app.get("/healthz", async () => {
    await sql`select 1`;
    return {
      ok: true,
      channel: deps.wa.channel,
      dryRun: deps.wa.dryRun,
      payment: payments.provider.name,
      models: availableModels().map((m) => m.model),
    };
  });

  app.get("/wa/webhook", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.WA_VERIFY_TOKEN && q["hub.challenge"]) {
      return reply.type("text/plain").send(q["hub.challenge"]);
    }
    return reply.code(403).send("forbidden");
  });

  app.post("/wa/webhook", async (req, reply) => {
    if (config.WA_APP_SECRET) {
      const signature = req.headers["x-hub-signature-256"];
      if (!req.rawBody || !verifySignature(req.rawBody, typeof signature === "string" ? signature : undefined, config.WA_APP_SECRET)) {
        return reply.code(401).send({ error: "invalid signature" });
      }
    } else if (!deps.wa.dryRun) {
      return reply.code(401).send({ error: "webhook signing is not configured" });
    }

    rememberPublicHost(req.hostname);
    const { messages, statuses } = parseWebhook(req.body);
    for (const s of statuses) {
      if (s.status === "failed") log.warn({ wamid: s.wamid, errors: s.errors }, "pesan keluar gagal terkirim");
    }

    await ingest(messages);
    return reply.code(200).send({ ok: true });
  });

  app.post("/fonnte/webhook/:secret", async (req, reply) => {
    const { secret } = req.params as { secret: string };
    if (!config.FONNTE_WEBHOOK_SECRET || !safeEqual(secret, config.FONNTE_WEBHOOK_SECRET)) {
      return reply.code(404).send({ error: "not found" });
    }
    rememberPublicHost(req.hostname);
    const parsed = parseFonnteWebhook(req.body);
    if (parsed.some((m) => m.inbound.kind === "unsupported")) {
      log.info({ fields: fonnteFieldsPresent(req.body) }, "pesan Fonnte tidak terbaca; ini field yang dikirim");
    }
    await ingest(parsed);
    return reply.code(200).send({ ok: true });
  });

  app.post("/pay/webhook", async (req, reply) => {
    try {
      const note = await payments.provider.parseWebhook({
        headers: req.headers,
        rawBody: req.rawBody ?? Buffer.alloc(0),
        body: req.body,
      });
      if (note) await payments.handleNotification(note);
      return { ok: true };
    } catch (err) {
      log.warn({ err }, "webhook pembayaran ditolak");
      return reply.code(400).send({ ok: false });
    }
  });

  await app.register(adminRoutes, { prefix: "/admin", payments });
  await app.register(uploadRoutes, { onQueued: (userId) => debouncer.poke(userId, config.MILO_DEBOUNCE_MS) });
  await app.register(locationRoutes, { onQueued: (userId) => debouncer.poke(userId, 300) });
  await app.register(googleRoutes, { onConnected: (result) => pipeline.googleConnected(result) });
  await app.register(notionRoutes, { onConnected: (result) => pipeline.notionConnected(result) });

  return { app, pipeline, debouncer, payments, scheduler, outbox };
}
