import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { runTool } from "../src/agent/tools.ts";
import { migrate, sql, type UserRow } from "../src/db/index.ts";
import {
  alignFirst,
  formatRepeat,
  matchesRule,
  nextFire,
  parseRepeat,
  RepeatError,
  toRule,
  zonedTime,
  type Repeat,
} from "../src/reminders/repeat.ts";
import { cancelReminder, listReminders, scheduleNext, type ReminderRow } from "../src/reminders/store.ts";

const JKT = "Asia/Jakarta";
const rule = (raw: string): Repeat => parseRepeat(raw).rule;
const at = (iso: string) => new Date(iso);
const local = (d: Date | undefined, tz = JKT) =>
  d && new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short", timeStyle: "short", hourCycle: "h23" }).format(d).replace(",", "");

describe("repeat rules", () => {
  test("rules are parsed from RRULE or plain words, and normalized back", () => {
    assert.deepEqual(rule("FREQ=WEEKLY;BYDAY=TH,MO"), { freq: "weekly", interval: 1, byDay: [1, 4] });
    assert.deepEqual(rule("RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=25"), { freq: "monthly", interval: 3, byMonthDay: 25 });
    assert.deepEqual(rule("hari kerja"), { freq: "weekly", interval: 1, byDay: [1, 2, 3, 4, 5] });
    assert.deepEqual(rule("harian"), { freq: "daily", interval: 1 });
    assert.equal(toRule(rule("freq=weekly;byday=mo,th")), "FREQ=WEEKLY;BYDAY=MO,TH");
    assert.equal(toRule(rule("FREQ=DAILY;INTERVAL=2")), "FREQ=DAILY;INTERVAL=2");
    assert.equal(toRule(rule("FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=12")), "FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=12");

    const until = parseRepeat("FREQ=DAILY;UNTIL=20261231T170000Z").until;
    assert.equal(until?.toISOString(), "2026-12-31T17:00:00.000Z");
  });

  test("a rule that cannot be honoured is refused with a reason", () => {
    const why = (raw: string) => {
      try {
        parseRepeat(raw);
        return "";
      } catch (err) {
        assert.ok(err instanceof RepeatError);
        return (err as Error).message;
      }
    };
    assert.match(why("FREQ=HOURLY"), /FREQ harus DAILY/);
    assert.match(why("FREQ=DAILY;BYDAY=MO"), /BYDAY hanya untuk FREQ=WEEKLY/);
    assert.match(why("FREQ=WEEKLY;BYDAY=XX"), /Hari "XX" tidak dikenal/);
    assert.match(why("FREQ=MONTHLY;BYMONTHDAY=41"), /BYMONTHDAY harus angka 1-31/);
    assert.match(why("FREQ=DAILY;COUNT=5"), /COUNT belum didukung/);
    assert.match(why("tiap purnama"), /tidak dikenal/);
    assert.match(why("  "), /kosong/);
  });

  test("the next occurrence keeps the local time of day", () => {
    const monday8 = at("2026-09-21T08:00:00+07:00");
    assert.equal(local(nextFire(rule("FREQ=DAILY"), monday8, JKT, monday8)), "2026-09-22 08:00");
    assert.equal(local(nextFire(rule("FREQ=DAILY;INTERVAL=3"), monday8, JKT, monday8)), "2026-09-24 08:00");
    assert.equal(local(nextFire(rule("FREQ=WEEKLY;BYDAY=MO,TH"), monday8, JKT, monday8)), "2026-09-24 08:00");
    assert.equal(local(nextFire(rule("FREQ=WEEKLY"), monday8, JKT, monday8)), "2026-09-28 08:00");
    assert.equal(local(nextFire(rule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"), monday8, JKT, monday8)), "2026-10-05 08:00");
    assert.equal(local(nextFire(rule("FREQ=MONTHLY"), monday8, JKT, monday8)), "2026-10-21 08:00");
    assert.equal(local(nextFire(rule("FREQ=YEARLY"), monday8, JKT, monday8)), "2027-09-21 08:00");
  });

  test("occurrences missed while the app was down are skipped, not fired in a burst", () => {
    const fired = at("2026-09-01T08:00:00+07:00");
    const backUp = at("2026-09-05T11:30:00+07:00");
    assert.equal(local(nextFire(rule("FREQ=DAILY"), fired, JKT, backUp)), "2026-09-06 08:00");
    assert.equal(local(nextFire(rule("FREQ=WEEKLY;BYDAY=TU"), fired, JKT, backUp)), "2026-09-08 08:00");
  });

  test("a day past the end of a short month falls on its last day, without drifting", () => {
    const jan31 = at("2027-01-31T09:00:00+07:00");
    const feb = nextFire(rule("FREQ=MONTHLY;BYMONTHDAY=31"), jan31, JKT, jan31)!;
    assert.equal(local(feb), "2027-02-28 09:00");
    const mar = nextFire(rule("FREQ=MONTHLY;BYMONTHDAY=31"), feb, JKT, feb)!;
    assert.equal(local(mar), "2027-03-31 09:00", "the rule's day wins over the day it was clamped to");

    const leapDay = at("2028-02-29T07:00:00+07:00");
    assert.equal(local(nextFire(rule("FREQ=YEARLY"), leapDay, JKT, leapDay)), "2029-02-28 07:00");
  });

  test("across a daylight saving change the wall clock stays put", () => {
    const beforeDst = at("2026-03-07T09:00:00-05:00"); // New York, before the spring change
    const next = nextFire(rule("FREQ=WEEKLY;BYDAY=SA"), beforeDst, "America/New_York", beforeDst)!;
    assert.equal(local(next, "America/New_York"), "2026-03-14 09:00");
    assert.equal(next.toISOString(), "2026-03-14T13:00:00.000Z", "the UTC instant shifts by an hour, the local time does not");
    assert.equal(zonedTime("2026-07-01", "09:00", JKT).toISOString(), "2026-07-01T02:00:00.000Z");
  });

  test("the first occurrence moves to the first day the rule allows", () => {
    const wednesday = at("2026-09-16T08:00:00+07:00");
    assert.equal(local(alignFirst(rule("FREQ=WEEKLY;BYDAY=MO"), wednesday, JKT)), "2026-09-21 08:00");
    assert.equal(local(alignFirst(rule("FREQ=WEEKLY;BYDAY=WE,SA"), wednesday, JKT)), "2026-09-16 08:00", "a day that already fits is left alone");
    assert.equal(local(alignFirst(rule("FREQ=MONTHLY;BYMONTHDAY=25"), wednesday, JKT)), "2026-09-25 08:00");
    assert.equal(local(alignFirst(rule("FREQ=DAILY"), wednesday, JKT)), "2026-09-16 08:00");
    assert.ok(matchesRule(rule("FREQ=MONTHLY;BYMONTHDAY=31"), "2026-02-28"), "a short month's last day counts as the 31st");
  });

  test("each rule is described in the words the user will read", () => {
    const monday = at("2026-09-21T08:00:00+07:00");
    const say = (raw: string) => formatRepeat(rule(raw), monday, JKT);
    assert.equal(say("FREQ=DAILY"), "setiap hari");
    assert.equal(say("FREQ=DAILY;INTERVAL=2"), "setiap 2 hari");
    assert.equal(say("FREQ=WEEKLY;BYDAY=MO,TH"), "setiap Senin & Kamis");
    assert.equal(say("hari kerja"), "setiap hari kerja (Senin–Jumat)");
    assert.equal(say("FREQ=WEEKLY"), "setiap Senin");
    assert.equal(say("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR"), "setiap 2 minggu pada Jumat");
    assert.equal(say("FREQ=MONTHLY"), "setiap bulan tanggal 21");
    assert.equal(say("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=25"), "setiap 3 bulan tanggal 25");
    assert.equal(say("FREQ=YEARLY"), "setiap tahun 21 September");
  });
});

describe("recurring reminders", { skip: !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run" }, () => {
  let user: UserRow;

  const scheduled = async () =>
    sql<ReminderRow[]>`
      select id, user_id, kind, text, fire_at, repeat, repeat_until, series_id from reminders
      where user_id = ${user.id} and status = 'scheduled' order by fire_at
    `;
  const create = (input: Record<string, unknown>) => runTool({ user }, "reminder_create", input);
  const said = (r: { content: unknown }) => String(r.content);

  before(async () => {
    await migrate();
    await sql`delete from users where wa_id = '6281390000001'`;
    const [u] = await sql<UserRow[]>`
      insert into users (wa_id, display_name, status, plan, state, timezone)
      values ('6281390000001', 'Uji', 'trialing', 'trial', 'READY', ${JKT}) returning *
    `;
    user = u!;
  });

  after(async () => {
    await sql`delete from users where id = ${user.id}`;
    await sql.end({ timeout: 5 });
  });

  test("a repeating reminder is created once and described back in words", async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const made = await create({ text: "setor laporan mingguan", at: `${soon}T08:00:00+07:00`, repeat: "FREQ=WEEKLY;BYDAY=MO" });
    assert.equal(made.isError, undefined);
    assert.match(said(made), /Pengingat berulang #\d+ dijadwalkan setiap Senin\./);
    assert.match(said(made), /Yang pertama: Senin/);

    const rows = await scheduled();
    assert.equal(rows.length, 1, "only the next occurrence is on the schedule");
    assert.equal(rows[0]!.repeat, "FREQ=WEEKLY;BYDAY=MO");
    assert.equal(rows[0]!.seriesId, rows[0]!.id, "the first row names the series");

    const listed = JSON.parse(said(await runTool({ user }, "reminder_list", {}))) as { repeat?: string }[];
    assert.equal(listed[0]!.repeat, "setiap Senin");
  });

  test("delivering one occurrence queues the next, and only one at a time", async () => {
    const [row] = await scheduled();
    const next = await scheduleNext(row!, user);
    assert.ok(next && next.getTime() > row!.fireAt.getTime() + 6 * 86_400_000, "a week later");

    await sql`update reminders set status = 'sent' where id = ${row!.id}`;
    const open = await scheduled();
    assert.equal(open.length, 1);
    assert.equal(open[0]!.seriesId, row!.id, "the new occurrence stays in the same series");
    assert.equal(await scheduleNext(row!, user), undefined, "a second delivery attempt does not double-book");
  });

  test("the series stops at its end date, and cancelling stops all of it", async () => {
    const [row] = await scheduled();
    const ending = { ...row!, repeatUntil: new Date(row!.fireAt.getTime() + 86_400_000) };
    await sql`update reminders set status = 'sent' where id = ${row!.id}`;
    assert.equal(await scheduleNext(ending, user), undefined, "the next Monday falls past the end date");

    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const made = await create({ text: "bayar gaji", at: `${soon}T09:00:00+07:00`, repeat: "FREQ=MONTHLY;BYMONTHDAY=25" });
    const id = Number(/#(\d+)/.exec(said(made))![1]);
    const cancelled = await cancelReminder(user, id);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.repeat, "FREQ=MONTHLY;BYMONTHDAY=25");
    assert.equal((await listReminders(user)).length, 0);
    assert.match(said(await runTool({ user }, "reminder_cancel", { id })), /Tidak ada pengingat aktif/);
  });

  test("a bad rule is refused before anything is scheduled", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const bad = await create({ text: "x", at: `${tomorrow}T09:00:00+07:00`, repeat: "FREQ=HOURLY" });
    assert.equal(bad.isError, true);
    assert.match(said(bad), /FREQ harus DAILY/);

    const backwards = await create({ text: "x", at: `${tomorrow}T09:00:00+07:00`, repeat: "FREQ=DAILY", until: "2020-01-01T00:00:00+07:00" });
    assert.equal(backwards.isError, true);
    assert.match(said(backwards), /Batas akhir pengulangan jatuh sebelum/);

    const noZone = await create({ text: "x", at: `${tomorrow} 09:00`, repeat: "FREQ=DAILY" });
    assert.equal(noZone.isError, true);
    assert.equal((await listReminders(user)).length, 0);
  });

  test("a one-off reminder still behaves exactly as before", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const made = await create({ text: "telepon Pak Andi", at: `${tomorrow}T09:00:00+07:00` });
    assert.match(said(made), /^Pengingat #\d+ dijadwalkan: /);
    const [row] = await listReminders(user);
    assert.equal(row!.repeat, null);
    assert.equal(row!.seriesId, null);
    assert.equal(await scheduleNext(row!, user), undefined);
    const id = Number(row!.id);
    assert.match(said(await runTool({ user }, "reminder_cancel", { id })), new RegExp(`Pengingat #${id} dibatalkan`));
  });
});
