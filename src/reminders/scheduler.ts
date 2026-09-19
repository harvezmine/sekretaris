import { config } from "../config.js";
import { getUser, sql, type UserRow } from "../db/index.js";
import { googleEnabled, listAccounts, servicesGranted } from "../google/client.js";
import { connectUrlFor } from "../google/connect.js";
import { BTN, googleExpired, trialNudge } from "../onboarding/copy.js";
import type { Agent } from "../agent/run.js";
import { recordStaticExchange } from "../agent/session.js";
import { hasAccess, type Payments } from "../payments/service.js";
import { localNow } from "../profile/agenda.js";
import { composeRoutine, dueRoutines, QUIET_BEFORE_MIN, ROUTINE_LABEL, routineFacts, type RoutineKind } from "../routines/routines.js";
import { WhatsAppError } from "../wa/client.js";
import type { Outbox } from "../wa/outbox.js";
import { errorMessage, type Logger } from "../util.js";
import { scheduleNext, type ReminderRow } from "./store.js";

const WINDOW_MS = 24 * 3_600_000 - 60_000;

function insideWindow(user: UserRow, channelHasWindow: boolean, now = Date.now()): boolean {
  if (!channelHasWindow) return true;
  return Boolean(user.lastInboundAt && now - user.lastInboundAt.getTime() < WINDOW_MS);
}

/** Delivers due reminders and expires stale QR charges. Runs in-process; one instance per database. */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private readonly outbox: Outbox,
    private readonly log: Logger,
    private readonly payments?: Payments,
    private readonly agent?: Agent,
  ) {}

  async start(intervalMs = 30_000): Promise<void> {
    const recovered = await sql`update reminders set status = 'scheduled' where status = 'sending' returning id`;
    if (recovered.length) this.log.warn({ count: recovered.length }, "pengingat yang terputus dijadwalkan ulang");
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.payments?.pollOpen();
      await sql`update payments set status = 'expired' where status = 'pending' and expires_at < now() - interval '5 minutes'`;
      const due = await sql<ReminderRow[]>`
        update reminders set status = 'sending'
        where id in (
          select id from reminders where status = 'scheduled' and fire_at <= now()
          order by fire_at limit 25 for update skip locked
        )
        returning id, user_id, kind, text, fire_at, repeat, repeat_until, series_id
      `;
      for (const r of due) await this.deliver(r);
      await this.sendRoutines();
      await this.notifyExpiredGoogle();
    } catch (err) {
      this.log.error({ err }, "scheduler gagal");
    } finally {
      this.busy = false;
    }
  }

  /**
   * The check-ins the secretary sends on its own: morning, lunch and end of day. Each goes out at most once per
   * local day, claimed before sending. It waits while the user is mid-conversation, is skipped rather than sent
   * hours late, and stays quiet for the first hour after someone joins.
   */
  async sendRoutines(now = new Date()): Promise<void> {
    const candidates = await sql<UserRow[]>`
      select * from users
      where status in ('trialing', 'active') and state = 'READY'
      order by id
      limit 500
    `;
    for (const user of candidates) {
      if (!hasAccess(user, now)) continue;
      const due = dueRoutines(user.profile, user.timezone, now);
      if (!due.length) continue;
      const local = localNow(user.timezone, now);
      const joined = Date.parse(user.profile?.setupDoneAt ?? "") || user.createdAt.getTime();
      const justJoined = now.getTime() - joined < 60 * 60_000;
      for (const d of due) {
        const busy = user.lastInboundAt && now.getTime() - user.lastInboundAt.getTime() < QUIET_BEFORE_MIN * 60_000;
        if (busy && !d.expired && !justJoined) continue;
        const alreadyBriefed = d.kind === "morning" && user.briefingSentOn && user.briefingSentOn.toISOString().slice(0, 10) >= local.date;
        const skip = d.expired || justJoined || Boolean(alreadyBriefed) || !insideWindow(user, this.outbox.wa.serviceWindow, now.getTime());
        const claimed = await sql`
          insert into routine_log (user_id, kind, on_date, sent) values (${user.id}, ${d.kind}, ${local.date}::date, ${!skip})
          on conflict do nothing
          returning 1
        `;
        if (!claimed.length || skip) continue;
        await this.sendRoutine(user, d.kind, d.weekend, local.date, now);
      }
    }
  }

  private async sendRoutine(user: UserRow, kind: RoutineKind, weekend: boolean, date: string, now: Date): Promise<void> {
    const unsent = () => sql`update routine_log set sent = false where user_id = ${user.id} and kind = ${kind} and on_date = ${date}::date`;
    try {
      const facts = await routineFacts(user, kind, now);
      // On a weekend the morning check-in only comes when there is actually something on.
      if (weekend && kind === "morning" && !facts.today.length) return void (await unsent());
      const { text, written } = await composeRoutine(kind, user, facts, { agent: this.agent, now });
      await this.outbox.text(user, text, { raw: true });
      const model = await this.agent?.modelFor(user).catch(() => null);
      if (model) await recordStaticExchange(user, model, `[Sapaan otomatis ${ROUTINE_LABEL[kind]}]`, text);
      if (!written) this.log.info({ userId: user.id, kind }, "sapaan otomatis memakai template");
    } catch (err) {
      await unsent().catch(() => {});
      this.log.warn({ err, userId: user.id, kind }, "sapaan otomatis gagal dikirim");
    }
  }

  /** Google refuses a refresh token (weekly in Testing mode): tell the user once, with a link to sign in again. */
  async notifyExpiredGoogle(): Promise<void> {
    if (!googleEnabled()) return;
    const expired = await sql<{ userId: string; email: string; scopes: string[] }[]>`
      select user_id, email, scopes from google_accounts where status = 'expired' and expired_notified_at is null limit 50
    `;
    for (const row of expired) {
      const user = await getUser(row.userId);
      const skip = !user || user.state === "OPTED_OUT" || !hasAccess(user) || !insideWindow(user, this.outbox.wa.serviceWindow);
      const url = skip ? undefined : connectUrlFor(row.userId, servicesGranted(row.scopes));
      if (!skip && !url) continue;
      // Per account: marking every row would silence the notice for an account that expires later.
      await sql`update google_accounts set expired_notified_at = now() where user_id = ${row.userId} and email = ${row.email}`;
      if (!user || !url) continue;
      const others = await listAccounts(row.userId);
      try {
        await this.outbox.text(user, googleExpired(url, others.length > 1 ? row.email : undefined), { raw: true });
      } catch (err) {
        this.log.warn({ err, userId: user.id }, "pemberitahuan login Google gagal dikirim");
      }
    }
  }

  private async finish(id: string, status: "sent" | "cancelled" | "failed", error?: string): Promise<void> {
    await sql`update reminders set status = ${status}, error = ${error ?? null} where id = ${id}`;
  }

  private async deliver(r: ReminderRow): Promise<void> {
    const user = await getUser(r.userId);
    if (!user || user.status === "opted_out" || user.status === "blocked") return this.finish(r.id, "cancelled");
    if (r.kind !== "trial_nudge") {
      try {
        await this.deliverReminder(r, user);
      } finally {
        await this.queueNext(r, user);
      }
      return;
    }
    return this.deliverNudge(r, user);
  }

  private async deliverNudge(r: ReminderRow, user: UserRow): Promise<void> {
    if (user.status !== "trialing" || !user.trialEndsAt) return this.finish(r.id, "cancelled");
    if (!insideWindow(user, this.outbox.wa.serviceWindow)) return this.finish(r.id, "failed", "di luar jendela 24 jam; nudge masa coba butuh template");
    const [stats] = await sql<{ files: string; reminders: string; answers: string }[]>`
      select
        (select count(*) from captures where user_id = ${user.id}) as files,
        (select count(*) from reminders where user_id = ${user.id} and kind = 'user' and status = 'sent') as reminders,
        (select count(*) from agent_runs where user_id = ${user.id} and error is null) as answers
    `;
    try {
      await this.outbox.buttons(
        user,
        trialNudge(
          {
            endsAt: user.trialEndsAt,
            files: Number(stats?.files ?? 0),
            reminders: Number(stats?.reminders ?? 0),
            answers: Number(stats?.answers ?? 0),
          },
          user.timezone,
        ),
        [BTN.subscribe, BTN.price],
      );
      return this.finish(r.id, "sent");
    } catch (err) {
      return this.finish(r.id, "failed", errorMessage(err));
    }
  }

  /** A repeating reminder queues its next occurrence even when this one failed, so one hiccup does not end the series. */
  private async queueNext(r: ReminderRow, user: UserRow): Promise<void> {
    if (!r.repeat) return;
    try {
      const next = await scheduleNext(r, user);
      this.log.info({ reminderId: r.id, next: next?.toISOString() ?? null }, next ? "pengingat berulang dijadwalkan lagi" : "pengingat berulang selesai");
    } catch (err) {
      this.log.warn({ err, reminderId: r.id, repeat: r.repeat }, "jadwal pengingat berulang berikutnya gagal dibuat");
    }
  }

  private async deliverReminder(r: ReminderRow, user: UserRow): Promise<void> {
    const who = user.profile?.callName;
    const text = `⏰ ${who ? `${who}, ini` : "Ini"} pengingatnya:\n${r.text}`;
    const template = config.WA_REMINDER_TEMPLATE;
    try {
      if (insideWindow(user, this.outbox.wa.serviceWindow)) {
        await this.outbox.text(user, text, { raw: true });
      } else if (template) {
        await this.outbox.template(user, template, [r.text]);
      } else {
        return this.finish(r.id, "failed", "di luar jendela 24 jam dan WA_REMINDER_TEMPLATE belum diatur");
      }
      return this.finish(r.id, "sent");
    } catch (err) {
      if (err instanceof WhatsAppError && err.outsideWindow && template) {
        try {
          await this.outbox.template(user, template, [r.text]);
          return this.finish(r.id, "sent");
        } catch (retryErr) {
          return this.finish(r.id, "failed", errorMessage(retryErr));
        }
      }
      this.log.warn({ err, reminderId: r.id }, "pengingat gagal dikirim");
      return this.finish(r.id, "failed", errorMessage(err));
    }
  }
}
