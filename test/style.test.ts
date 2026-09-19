import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { runTool } from "../src/agent/tools.ts";
import { buildSnapshot } from "../src/agent/prompt.ts";
import { migrate, sql, type UserRow } from "../src/db/index.ts";
import { profilePromptLines, profileSummary } from "../src/profile/profile.ts";
import { addRule, forgetRule, listRules, MAX_RULES } from "../src/profile/rules.ts";
import { describeStyle, readStyle, refreshStyle, styleSummary } from "../src/profile/style.ts";

const dbEnabled = Boolean(process.env.TEST_DATABASE_URL);

/** A boss who texts the way most people do: short, lowercase, no full stops, plenty of slang. */
const CASUAL = [
  "ingetin besok jam 9 rapat vendor ya",
  "eh tambah, jam 11 ketemu notaris",
  "besok gue sibuk apa aja",
  "oke sip",
  "tolong kabarin pak andi dong",
  "udah dikirim belum",
  "nggak usah, nanti aja",
  "makasih ya 🙏",
  "btw omzet depok hari ini 4,2 juta",
  "kamu bisa cariin restoran deket sini nggak",
];

/** And one who writes like a letter. */
const FORMAL = [
  "Selamat pagi. Mohon ingatkan saya rapat vendor besok pukul 09.00.",
  "Tolong tambahkan agenda bertemu notaris pukul 11.00.",
  "Apa saja agenda saya besok?",
  "Baik, terima kasih.",
  "Mohon kabari Pak Andi mengenai penawaran kami.",
  "Apakah dokumennya sudah dikirim?",
  "Belum perlu, nanti saja.",
  "Terima kasih atas bantuannya.",
  "Saya ingin Anda mencatat omzet cabang Depok hari ini.",
  "Bisakah Anda mencarikan restoran terdekat?",
];

describe("the style Milo reads from the user's own messages", () => {
  test("a casual writer and a formal one come out different", () => {
    const casual = readStyle(CASUAL)!;
    assert.ok(casual, "ten messages is enough to conclude something");
    assert.ok(casual.words <= 8, `median ${casual.words} words`);
    assert.ok(casual.slang >= 0.4, `slang ${casual.slang}`);
    assert.ok(casual.lowercase >= 0.8);
    assert.ok(casual.unpunctuated >= 0.8);
    assert.equal(casual.address, "kamu");
    assert.ok(casual.emoji > 0 && casual.emoji < 0.3);

    const formal = readStyle(FORMAL)!;
    // Both write short messages: what separates a formal writer from a casual one is never length.
    assert.equal(formal.words, casual.words);
    assert.equal(formal.slang, 0);
    assert.equal(formal.lowercase, 0);
    assert.equal(formal.unpunctuated, 0);
    assert.equal(formal.address, "anda");
    assert.equal(formal.emoji, 0);
  });

  test("it says nothing at all until there is enough to go on", () => {
    assert.equal(readStyle(CASUAL.slice(0, 7)), undefined, "seven messages is a guess, not an observation");
    assert.equal(readStyle(["", "   ", "ok"]), undefined);
    assert.ok(readStyle(CASUAL.slice(0, 8)));
  });

  test("one pasted paragraph does not redraw the picture", () => {
    const withEssay = [...CASUAL, "ini hasil rapatnya ".repeat(60)];
    assert.ok(readStyle(withEssay)!.words <= 8, "the median holds where an average would not");
  });

  test("what the model is told, and what the user is shown, match", () => {
    const casual = describeStyle(readStyle(CASUAL)!);
    assert.match(casual, /very short messages/);
    assert.match(casual, /everyday slang/);
    assert.match(casual, /lowercase openings/);
    assert.match(casual, /calls you "kamu"/);
    assert.match(casual, /never go below a professional floor/i, "mirror the register, not the carelessness");
    assert.match(casual, /do not quote it back at them/, "learned, not announced");

    assert.match(describeStyle(readStyle(FORMAL)!), /no slang, .*never any emoji.*calls you "Anda"/);
    assert.equal(styleSummary(readStyle(CASUAL)!), "pesan pendek, santai, huruf kecil, memanggil saya kamu");
    assert.equal(styleSummary(readStyle(FORMAL)!), "pesan pendek, rapi, memanggil saya Anda");

    const longWinded = Array.from({ length: 8 }, (_, i) => `Mohon disiapkan laporan lengkap untuk rapat direksi minggu depan, ${"termasuk rincian per cabang ".repeat(3)} nomor ${i}.`);
    assert.match(describeStyle(readStyle(longWinded)!), /long messages \(about \d+ words\)/);
    assert.match(styleSummary(readStyle(longWinded)!), /^pesan panjang/);
  });
});

describe("rules the user gives, and the profile they can read back", { skip: !dbEnabled && "set TEST_DATABASE_URL to run" }, () => {
  let user: UserRow;

  const seed = async (texts: string[], atHoursAgo = 0) => {
    for (const body of texts) {
      await sql`
        insert into messages (user_id, wamid, direction, kind, body, processed, created_at)
        values (${user.id}, ${`seed.${Math.random()}`}, 'in', 'text', ${body}, true, now() - ${`${atHoursAgo} hours`}::interval)
      `;
    }
  };

  before(async () => {
    await migrate();
    await sql`delete from users where wa_id = '6286600000001'`;
    const [row] = await sql<UserRow[]>`
      insert into users (wa_id, display_name, status, plan, state, consent_at, trial_ends_at, llm_model)
      values ('6286600000001', 'Josh', 'trialing', 'trial', 'READY', now(), now() + interval '7 days', 'claude-opus-5')
      returning *
    `;
    user = row!;
  });

  after(async () => {
    await sql`delete from users where id = ${user.id}`;
    await sql.end({ timeout: 5 });
  });

  test("a correction is kept, restated once, and dropped when the user changes their mind", async () => {
    assert.equal((await listRules(user.id)).length, 0);

    const added = await addRule(user.id, "Jawab singkat, maksimal dua kalimat");
    assert.equal(added!.status, "added");
    assert.equal((await addRule(user.id, "jawab singkat, maksimal dua kalimat"))!.status, "same", "the same rule twice is still one rule");

    const restated = await addRule(user.id, "Jawab singkat, maksimal dua kalimat, tanpa basa-basi");
    assert.equal(restated!.status, "replaced");
    assert.equal(restated!.dropped, "Jawab singkat, maksimal dua kalimat");
    assert.equal((await listRules(user.id)).length, 1, "a restatement replaces rather than piles up");

    await addRule(user.id, "Jangan pakai emoji");
    assert.equal((await listRules(user.id)).length, 2);
    assert.equal(await addRule(user.id, "ok"), undefined, "too short to mean anything");

    const gone = await forgetRule(user.id, "emoji");
    assert.equal(gone!.rule, "Jangan pakai emoji");
    assert.equal(await forgetRule(user.id, "sesuatu yang tidak ada"), undefined);
    assert.equal((await listRules(user.id)).length, 1);
  });

  test("the list stays short enough to read, oldest first out", async () => {
    await sql`delete from user_rules where user_id = ${user.id}`;
    for (let i = 1; i <= MAX_RULES + 3; i++) await addRule(user.id, `Aturan nomor ${i} tentang cara kerja`);
    const rules = await listRules(user.id);
    assert.equal(rules.length, MAX_RULES);
    assert.equal(rules[0]!.rule, "Aturan nomor 4 tentang cara kerja", "the three oldest made way");
    assert.equal(rules.at(-1)!.rule, `Aturan nomor ${MAX_RULES + 3} tentang cara kerja`);
    await sql`delete from user_rules where user_id = ${user.id}`;
  });

  test("the model calls it a rule, and the user sees the same words back", async () => {
    const added = JSON.parse(String((await runTool({ user }, "style_rule", { rule: "Jangan tanya balik, langsung kerjakan" })).content)) as {
      added: string;
    };
    assert.equal(added.added, "Jangan tanya balik, langsung kerjakan");

    const fresh = (await sql<UserRow[]>`select * from users where id = ${user.id}`)[0]!;
    const lines = profilePromptLines(fresh, (await listRules(user.id)).map((r) => r.rule));
    assert.match(lines.join("\n"), /Rules this user has given you.+"Jangan tanya balik, langsung kerjakan"/);
    assert.match(profileSummary(fresh, [], ["Jangan tanya balik, langsung kerjakan"]), /\*Aturan dari Anda:\*\n• Jangan tanya balik/);

    const forgotten = JSON.parse(String((await runTool({ user }, "style_rule", { rule: "tanya balik", forget: true })).content)) as { forgot: string };
    assert.equal(forgotten.forgot, "Jangan tanya balik, langsung kerjakan");
    assert.equal((await listRules(user.id)).length, 0);
    assert.match(String((await runTool({ user }, "style_rule", { rule: "yang ini tidak ada", forget: true })).content), /Tidak ada aturan yang cocok/);
  });

  test("style is computed from real messages, stored, and left alone until it goes stale", async () => {
    assert.equal(await refreshStyle(user), undefined, "nothing said yet, so nothing concluded");

    await seed(CASUAL);
    const fresh = (await sql<UserRow[]>`select * from users where id = ${user.id}`)[0]!;
    const card = (await refreshStyle(fresh))!;
    assert.equal(card.address, "kamu");
    assert.ok(card.slang >= 0.4);

    const stored = (await sql<UserRow[]>`select * from users where id = ${user.id}`)[0]!;
    assert.deepEqual(stored.profile.style, card, "it lives on the profile, where the user can be shown it");
    assert.match(profileSummary(stored, []), /Gaya Anda yang saya perhatikan: pesan pendek, santai/);
    assert.match(await buildSnapshot(stored), /How they write, counted from their own last 10 messages/);

    // A second turn must not pay for the same arithmetic.
    const before = (await sql<{ n: string }[]>`select count(*) as n from messages where user_id = ${user.id}`)[0]!.n;
    const again = await refreshStyle(stored);
    assert.equal(again!.at, card.at, "still fresh, so untouched");
    assert.equal((await sql<{ n: string }[]>`select count(*) as n from messages where user_id = ${user.id}`)[0]!.n, before);

    // Four days later the same user now writes like a letter, and the picture follows them.
    await sql`update users set profile = profile || ${sql.json({ style: { ...card, at: new Date(Date.now() - 4 * 86_400_000).toISOString() } } as never)} where id = ${user.id}`;
    await sql`delete from messages where user_id = ${user.id}`;
    await seed(FORMAL);
    const later = (await sql<UserRow[]>`select * from users where id = ${user.id}`)[0]!;
    const redrawn = (await refreshStyle(later))!;
    assert.equal(redrawn.address, "anda");
    assert.equal(redrawn.slang, 0);
  });
});
