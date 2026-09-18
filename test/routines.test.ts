import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { UserRow } from "../src/db/index.ts";
import type { Agent } from "../src/agent/run.ts";
import { composeRoutine, dueRoutines, factsHold, fallbackRoutine, routineTime, type RoutineFacts } from "../src/routines/routines.ts";
import { routineSummary } from "../src/profile/profile.ts";

const JKT = "Asia/Jakarta";
// 2026-09-16 is a Wednesday, 2026-09-19 a Saturday.
const at = (date: string, clock: string) => new Date(`${date}T${clock}:00+07:00`);
const facts = (today: string[] = [], tomorrow: string[] = [], mail: string[] = []): RoutineFacts => ({
  today,
  tomorrow,
  mail,
  times: new Set([...today, ...tomorrow].flatMap((l) => [...l.matchAll(/\b(\d{2})[.:](\d{2})\b/g)].map((m) => `${m[1]}.${m[2]}`))),
});
const user = (profile: object = {}) => ({ id: "1", timezone: JKT, profile, assistantName: null, persona: null }) as unknown as UserRow;

describe("check-ins the secretary sends on its own", () => {
  test("they are on by default, can be moved or switched off, and the old morning setting still counts", () => {
    assert.equal(routineTime({}, "morning"), "07:30");
    assert.equal(routineTime({}, "lunch"), "12:00");
    assert.equal(routineTime({}, "evening"), "17:30");
    assert.equal(routineTime({ briefingTime: "06:15" }, "morning"), "06:15", "a morning time set before check-ins existed");
    assert.equal(routineTime({ briefingTime: "06:15", routines: { morning: "08:00" } }, "morning"), "08:00");
    assert.equal(routineTime({ routines: { lunch: "off" } }, "lunch"), undefined);
    assert.equal(routineSummary({ routines: { lunch: "off", evening: "18:00" } }, "id"), "pagi 07.30, siang mati, sore 18.00 (hari kerja)");
  });

  test("each is due from its time, until it would arrive too late to make sense", () => {
    const kinds = (clock: string, profile = {}) => dueRoutines(profile, JKT, at("2026-09-16", clock)).map((d) => `${d.kind}${d.expired ? "!" : ""}`);
    assert.deepEqual(kinds("07:29"), []);
    assert.deepEqual(kinds("07:30"), ["morning"]);
    assert.deepEqual(kinds("10:31"), ["morning!"], "three hours late: claim the day, send nothing");
    assert.deepEqual(kinds("12:10"), ["morning!", "lunch"]);
    assert.deepEqual(kinds("17:31"), ["morning!", "lunch!", "evening"]);
    assert.deepEqual(kinds("12:10", { routines: { lunch: "off" } }), ["morning!"]);
  });

  test("weekends keep only the morning, and flag it so it can stay quiet when nothing is on", () => {
    const due = dueRoutines({}, JKT, at("2026-09-19", "17:40"));
    assert.deepEqual(due.map((d) => [d.kind, d.weekend]), [["morning", true]]);
  });

  test("a written message may only mention times that are on the agenda", () => {
    const f = facts(["09.00 Presentasi investor", "13.30-14.30 Rapat vendor"]);
    assert.ok(factsHold("Pagi. Jam 09.00 ada presentasi, lalu 13.30 rapat vendor.", f));
    assert.ok(factsHold("Pagi, Pak. Hari ini cukup padat.", f), "no times at all is fine");
    assert.equal(factsHold("Jangan lupa rapat jam 16.00.", f), false);
    assert.equal(factsHold("Sudah jam 12.00, makan dulu ya.", f), false);
    assert.ok(factsHold("Sudah jam 12.00, makan dulu ya.", f, ["12.00"]), "the check-in's own time may be named");
  });

  test("the plain version is correct, personal, and varies with the day", () => {
    const pak = user({ callName: "Pak Andi" });
    assert.equal(
      fallbackRoutine("morning", pak, facts(["09.00 Presentasi investor"]), at("2026-09-16", "07:30")),
      "Selamat pagi, Pak Andi. Hari ini ada 09.00 Presentasi investor. Ada lagi yang perlu saya catat untuk hari ini?",
    );
    const busy = fallbackRoutine("morning", pak, facts(["09.00 A", "11.00 B", "15.00 C"], [], ["Andi: Invoice"]), at("2026-09-16", "07:30"));
    assert.equal(busy, "Selamat pagi, Pak Andi. Hari ini ada 3 agenda:\n• 09.00 A\n• 11.00 B\n• 15.00 C\nAda 1 email penting yang belum dibaca: Andi: Invoice. Ada lagi yang perlu saya catat untuk hari ini?");
    assert.match(fallbackRoutine("morning", user(), facts(), at("2026-09-16", "07:30")), /^(Selamat pagi|Pagi)\. /, "no name when none was given");
    const lunches = new Set(["2026-09-14", "2026-09-15", "2026-09-16"].map((d) => fallbackRoutine("lunch", pak, facts(), at(d, "12:00"))));
    assert.equal(lunches.size, 3, "not the same sentence every day");
    assert.equal(
      fallbackRoutine("evening", pak, facts([], ["08.00 Rapat direksi"]), at("2026-09-16", "17:30")),
      "Hari kerja hampir selesai, Pak Andi. Besok dimulai dengan 08.00 Rapat direksi. Ada yang perlu saya ingatkan besok?",
    );
    for (const text of [busy, ...lunches]) assert.doesNotMatch(text, /—/);
  });

  test("a message the model did not finish is never sent; the plain one goes instead", async () => {
    const agentSaying = (reply: { text: string; stopReason: string | null }) =>
      ({ brief: async () => ({ ...reply, calls: [] }) }) as unknown as Agent;
    const now = at("2026-09-16", "07:30");
    const f = facts(["10.00 Review keuangan"]);
    const pak = user({ callName: "Pak Josh" });

    const cut = await composeRoutine("morning", pak, f, { agent: agentSaying({ text: "Pagi, Pak Josh. Hari ini ada review keuangan jam 10.00. Ada rencana lain yang perlu saya cat", stopReason: "max_tokens" }), now });
    assert.equal(cut.written, false, "cut off by the token limit");
    assert.equal(cut.text, "Selamat pagi, Pak Josh. Hari ini ada 10.00 Review keuangan. Ada lagi yang perlu saya catat untuk hari ini?");

    const empty = await composeRoutine("lunch", pak, f, { agent: agentSaying({ text: "", stopReason: "max_tokens" }), now: at("2026-09-16", "12:00") });
    assert.equal(empty.written, false, "all of it spent thinking");

    const whole = await composeRoutine("morning", pak, f, { agent: agentSaying({ text: "Pagi, Pak Josh — jam 10.00 ada review keuangan.", stopReason: "end_turn" }), now });
    assert.deepEqual(whole, { text: "Pagi, Pak Josh, jam 10.00 ada review keuangan.", written: true }, "and an em dash never reaches the user");
  });
});
