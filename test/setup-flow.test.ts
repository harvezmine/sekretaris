import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { config } from "../src/config.ts";
import type { UserRow } from "../src/db/index.ts";
import { helpText, SETUP, welcome } from "../src/onboarding/copy.ts";
import { isYes, keywordAction, looksLikeRequest, nextStep, quickRows, SETUP_ORDER, SKIP } from "../src/onboarding/setup.ts";
import { localNow } from "../src/profile/agenda.ts";
import { normalizeCallName, normalizeWork, parseClock, profilePromptLines } from "../src/profile/profile.ts";
import { assertButtons, assertList } from "../src/wa/client.ts";
import { matchMenuReply, renderMenu } from "../src/wa/menu.ts";

const user = (patch: Partial<UserRow> = {}) => ({ id: "1", waId: "6281", displayName: "Josh", profile: {}, ...patch }) as UserRow;

describe("getting to know the user", () => {
  test("answers are parsed leniently", () => {
    for (const [input, out] of [
      ["7", "07:00"],
      ["07.30", "07:30"],
      ["6:15", "06:15"],
      ["jam 6.45", "06:45"],
      ["pukul 05.00 pagi", "05:00"],
      ["21.00 WIB", "21:00"],
    ] as const) {
      assert.equal(parseClock(input), out, input);
    }
    for (const bad of ["24.00", "7.60", "besok pagi", "", "07:00:00"]) assert.equal(parseClock(bad), undefined, bad);

    assert.equal(normalizeCallName(" Pak   Josh. "), "Pak Josh");
    assert.equal(normalizeCallName("Bu Rina"), "Bu Rina");
    for (const bad of ["", "Pak Josh yang paling ganteng sekali", "<b>Bos</b>", "Bos!!!?"]) {
      assert.equal(normalizeCallName(bad), undefined, bad);
    }
    assert.equal(normalizeWork("punya 3 cabang kedai kopi"), "punya 3 cabang kedai kopi");
    assert.equal(normalizeWork("x"), undefined);
    assert.equal(normalizeWork("a".repeat(201)), undefined);

    assert.ok(SKIP.test("lewati") && SKIP.test("Nanti") && SKIP.test("ga usah"));
    for (const yes of ["ya", "iya", "boleh", "mau dong", "oke", "silakan", "Sip"]) assert.ok(isYes(yes), yes);
    for (const no of ["nanti", "gak usah", "apa itu?", ""]) assert.equal(isYes(no), false, no);
  });

  test("questions and instructions are not mistaken for answers", () => {
    assert.equal(looksLikeRequest("Pak Josh", "callName"), false);
    assert.equal(looksLikeRequest("punya 3 cabang kedai kopi di Jakarta Selatan dan Bekasi", "work"), false);
    assert.equal(looksLikeRequest("boleh", "connect"), false);
    assert.equal(looksLikeRequest("ingetin besok jam 9 rapat", "callName"), true);
    assert.equal(looksLikeRequest("jadwal saya hari ini?", "work"), true);
    assert.equal(looksLikeRequest("tolong kirim pesan ke Andi", "connect"), true);
    assert.equal(looksLikeRequest("saya mau nanya soal laporan bulan lalu", "connect"), true);
    assert.equal(keywordAction("AGENDA"), "agenda");
    assert.equal(keywordAction("jadwal hari ini"), "agenda");
    assert.equal(keywordAction("Profil"), "profile");
    assert.equal(keywordAction("gaya"), "style");
    assert.equal(keywordAction("bantuan"), "help");
    assert.equal(keywordAction("agenda rapat besok"), undefined);
    assert.deepEqual(SETUP_ORDER, ["callName", "work", "connect"], "three questions, and nothing to tap");
    assert.equal(nextStep("work"), undefined, "no connect step when nothing can be connected");
    assert.equal(nextStep("work", true), "connect");
    assert.equal(nextStep("connect", true), undefined);
  });

  test("the first message is short, says nothing about features, and carries the notice", () => {
    const hello = welcome("Josh");
    assert.ok(hello.length < 300, `${hello.length} karakter`);
    assert.equal(hello.split("\n").filter(Boolean).length, 3);
    assert.match(hello, /Halo Josh/);
    assert.match(hello, /kode undangan/);
    assert.match(hello, /menyimpan nomor dan percakapan/);
    for (const feature of [/Cek server/, /Google/, /pengingat/i, /kepribadian/i]) {
      assert.ok(!feature.test(hello), `perkenalan tidak menyebut ${feature}`);
    }
    assert.match(SETUP.callName("Josh"), /saya panggil Anda apa\?/i);
    assert.ok(!/\d\/\d/.test(SETUP.work), "no step numbering");
  });

  test("the quick menu fits a WhatsApp list even with every feature on", () => {
    const original = { ...config };
    try {
      Object.assign(config, { WA_PROVIDER: "fonnte", MESSAGE_SEND_ACCESS: "all", SERVER_ACCESS: "all" });
      const rows = quickRows(user());
      assert.equal(rows.length, 9);
      assert.ok(rows.some((r) => r.id === "qa:server") && rows.some((r) => r.title === "✉️ Kirim pesan"));
      assertList("Pilih", "Pilih menu", rows);
      assert.match(helpText({ attachments: false, servers: true }), /ketik \*FILE\*/);
    } finally {
      Object.assign(config, original);
    }
    const plain = quickRows(user());
    assert.ok(!plain.some((r) => r.id === "qa:server"));
    assert.ok(plain.some((r) => r.title === "✉️ Susun pesan"));
    assert.throws(() => assertList("x", "x", Array.from({ length: 11 }, (_, i) => ({ id: `${i}`, title: "a" }))));
    assert.throws(() => assertList("x", "x", [{ id: "a", title: "judul yang terlalu panjang sekali" }]));
  });

  test("numbered menus show descriptions and accept typed titles without emoji", () => {
    const rows = quickRows(user());
    assert.match(renderMenu("Menu", rows), /\*1\.\* 📅 Agenda hari ini — Pengingat hari ini dan besok/);
    assert.equal(matchMenuReply("agenda hari ini", rows)?.id, "qa:agenda");
    assert.equal(matchMenuReply("  Profil Saya ", rows)?.id, "qa:profile");
    assert.equal(matchMenuReply("8", rows)?.id, "qa:account");
    assert.equal(matchMenuReply("9", rows), undefined);
    assert.equal(matchMenuReply("😀", rows), undefined);
  });

  test("the model sees the profile, including how to address the user", () => {
    const lines = profilePromptLines(user({ profile: { callName: "Pak Josh", work: "kontraktor", answerStyle: "singkat", briefingTime: "06:30" } }));
    assert.match(lines[0]!, /^Address the user as: Pak Josh \(the user's choice/);
    assert.match(lines.join("\n"), /Work or business: kontraktor\nAnswer length preference: short .+\nCheck-ins you send on your own: morning 06:30, lunch 12:00 \(weekdays\), evening 17:30 \(weekdays\)/);
    assert.match(profilePromptLines(user()).join("\n"), /not set/);
    assert.deepEqual(localNow("Asia/Jakarta", new Date("2026-09-17T23:30:00Z")), { date: "2026-09-18", clock: "06:30", offset: "+07:00" });
  });
});
