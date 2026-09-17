import { config } from "../config.js";
import { getUser, sql, type UserRow } from "../db/index.js";
import { BTN, trialNudge } from "../onboarding/copy.js";
import { WhatsAppError } from "../wa/client.js";
import type { Payments } from "../payments/service.js";
import type { Outbox } from "../wa/outbox.js";
import { errorMessage, type Logger } from "../util.js";

interface ReminderRow {
  id: string;
  userId: string;
  kind: "user" | "trial_nudge";
  text: string;
  fireAt: Date;
}

const WINDOW_MS = 24 * 3_600_000 - 60_000;

function insideWindow(user: UserRow, channelHasWindow: boolean): boolean {
  if (!channelHasWindow) return true;
  return Boolean(user.lastInboundAt && Date.now() - user.lastInboundAt.getTime() < WINDOW_MS);
}

/** Delivers due reminders and expires stale QR charges. Runs in-process; one instance per database. */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private readonly outbox: Outbox,
    private readonly log: Logger,
    private readonly payments?: Payments,
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
        returning id, user_id, kind, text, fire_at
      `;
      for (const r of due) await this.deliver(r);
    } catch (err) {
      this.log.error({ err }, "scheduler gagal");
    } finally {
      this.busy = false;
    }
  }

  private async finish(id: string, status: "sent" | "cancelled" | "failed", error?: string): Promise<void> {
    await sql`update reminders set status = ${status}, error = ${error ?? null} where id = ${id}`;
  }

  private async deliver(r: ReminderRow): Promise<void> {
    const user = await getUser(r.userId);
    if (!user || user.status === "opted_out" || user.status === "blocked") return this.finish(r.id, "cancelled");

    if (r.kind === "trial_nudge") {
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

    const text = `⏰ *Pengingat*\n${r.text}`;
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
