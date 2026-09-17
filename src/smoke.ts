import { availableModels, providerFor } from "./agent/providers.js";
import { Agent } from "./agent/run.js";
import { config } from "./config.js";
import { migrate, sql, type UserRow } from "./db/index.js";

/**
 * Two real Claude calls against the configured model, to check credentials, tool use and prompt caching before
 * real users arrive. Costs a few cents. The temporary user is deleted at the end.
 */
async function main(): Promise<void> {
  await migrate();
  const forced = process.argv[2];
  const options = availableModels();
  const model = forced ?? options[0]?.model;
  if (!model) throw new Error("Tidak ada model dengan API key terisi. Cek MILO_MODELS dan API key di .env.");
  if (!options.some((o) => o.model === model)) {
    throw new Error(`Model ${model} tidak ada di MILO_MODELS/MILO_MODEL atau API key-nya kosong.`);
  }
  const waId = `smoke-${Date.now()}`;
  const [user] = await sql<UserRow[]>`
    insert into users (wa_id, display_name, status, plan, state, consent_at, trial_ends_at, timezone, llm_model)
    values (${waId}, 'Uji Asap', 'trialing', 'trial', 'READY', now(), now() + interval '1 day', ${config.DEFAULT_TIMEZONE}, ${model})
    returning *
  `;
  const log = {
    info: () => {},
    debug: () => {},
    warn: (o: unknown, m?: string) => console.warn("WARN", m ?? "", o),
    error: (o: unknown, m?: string) => console.error("ERROR", m ?? "", o),
  };
  const agent = new Agent(log);
  try {
    console.log(`Model: ${model} (${providerFor(model)}) · effort: ${config.MILO_EFFORT}\n`);
    for (const prompt of [
      "Halo Milo, ingatkan saya besok jam 9 pagi untuk menelepon Pak Andi.",
      "Makasih. Pengingat apa saja yang saya punya sekarang?",
    ]) {
      const r = await agent.run(user!, prompt, { softMode: false });
      console.log(`> ${prompt}\n${r.reply}\n  (${r.steps} panggilan, $${r.costUsd.toFixed(5)})\n`);
    }
    const rows = await sql<{ model: string; inputTokens: number; cacheWrite1h: number; cacheWrite5m: number; cacheRead: number; outputTokens: number; costUsd: string }[]>`
      select model, input_tokens, cache_write_1h, cache_write_5m, cache_read, output_tokens, cost_usd
      from usage_ledger where user_id = ${user!.id} order by id
    `;
    console.table(rows.map((r) => ({ ...r, costUsd: Number(r.costUsd) })));
    const total = rows.reduce((a, r) => a + Number(r.costUsd), 0);
    const reads = rows.slice(1).some((r) => r.cacheRead > 0);
    console.log(`Total: $${total.toFixed(5)}`);
    console.log(reads ? "Prompt cache: OK (ada cache_read pada panggilan berikutnya)." : "PERINGATAN: tidak ada cache_read — periksa prefix prompt.");
  } finally {
    await sql`delete from users where id = ${user!.id}`;
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
