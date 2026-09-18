import { z } from "zod";

try {
  process.loadEnvFile();
} catch {
  // .env is optional: under Docker the variables arrive through env_file.
}

const schema = z
  .object({
    PORT: z.coerce.number().int().default(3000),
    PUBLIC_BASE_URL: z.string().default(""),
    DATABASE_URL: z.string().min(1),
    DATA_DIR: z.string().default("./data"),
    DEFAULT_TIMEZONE: z.string().default("Asia/Jakarta"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    WA_PROVIDER: z.enum(["meta", "fonnte"]).default("meta"),
    WA_PHONE_NUMBER_ID: z.string().default(""),
    WA_ACCESS_TOKEN: z.string().default(""),
    WA_APP_SECRET: z.string().default(""),
    WA_VERIFY_TOKEN: z.string().default(""),
    FONNTE_TOKEN: z.string().default(""),
    FONNTE_WEBHOOK_SECRET: z.string().default(""),
    FONNTE_TYPING: z.stringbool().default(true),
    WA_GRAPH_VERSION: z.string().default("v25.0"),
    WA_DRY_RUN: z.stringbool().default(false),
    WA_REMINDER_TEMPLATE: z.string().default(""),
    WA_TEMPLATE_LANG: z.string().default("id"),
    WA_TEMPLATE_USD: z.coerce.number().default(0.024),

    MILO_MODEL: z.string().default("claude-opus-5"),
    MILO_MODELS: z.string().default(""),
    DEEPSEEK_API_KEY: z.string().default(""),
    DEEPSEEK_BASE_URL: z.string().default("https://api.deepseek.com/anthropic"),
    MILO_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
    MILO_FALLBACKS: z.enum(["default", "off"]).default("default"),
    MILO_MAX_STEPS: z.coerce.number().int().min(2).max(20).default(6),
    MILO_DEBOUNCE_MS: z.coerce.number().int().min(0).default(4000),
    MILO_SLOW_NOTICE_MS: z.coerce.number().int().default(8000),

    FONNTE_ATTACHMENTS: z.stringbool().default(false),
    UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(100).default(25),
    UPLOAD_LINK_HOURS: z.coerce.number().int().min(1).max(168).default(24),

    MESSAGE_SEND_ACCESS: z.enum(["off", "admin", "all"]).default("all"),
    MESSAGE_SEND_DAILY_LIMIT: z.coerce.number().int().min(0).max(500).default(20),
    RELAY_REPLY_HOURS: z.coerce.number().int().min(1).max(720).default(72),

    /** Self-hosted SearXNG; empty turns web search off unless Tavily is configured. */
    SEARXNG_URL: z.string().default(""),
    TAVILY_API_KEY: z.string().default(""),
    WEB_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(20).default(6),
    /** auto = Google Places when a key is set, OpenStreetMap otherwise. off turns place search off entirely. */
    PLACES_PROVIDER: z.enum(["auto", "google", "osm", "off"]).default("auto"),
    /** Google Places (server API key, not OAuth). Billed per search; leave empty to stay on OpenStreetMap. */
    GOOGLE_MAPS_API_KEY: z.string().default(""),
    PLACE_SEARCHES_PER_DAY: z.coerce.number().int().min(0).max(500).default(30),
    OVERPASS_URL: z.string().default("https://overpass-api.de/api/interpreter"),
    NOMINATIM_URL: z.string().default("https://nominatim.openstreetmap.org/search"),
    WEB_READ_MAX_CHARS: z.coerce.number().int().min(1000).max(50_000).default(12_000),

    GOOGLE_CLIENT_ID: z.string().default(""),
    GOOGLE_CLIENT_SECRET: z.string().default(""),
    /** Override when Google must call back somewhere other than PUBLIC_BASE_URL/google/callback. */
    GOOGLE_REDIRECT_URL: z.string().default(""),
    GOOGLE_SERVICES: z.string().default("calendar,gmail,drive,contacts"),
    /** Restricted scopes: fine in Testing mode, need a CASA assessment for a public app. */
    GOOGLE_GMAIL_READ: z.stringbool().default(true),
    GOOGLE_DRIVE_FULL: z.stringbool().default(true),

    SERVER_ACCESS: z.enum(["off", "admin", "all"]).default("admin"),
    /** Running commands on a user's own server. Needs SERVER_ACCESS too: you cannot act on a server you cannot see. */
    SERVER_ACTION_ACCESS: z.enum(["off", "admin", "all"]).default("all"),
    SERVER_ADMIN_NUMBERS: z.string().default(""),
    SERVER_KEY_SECRET: z.string().default(""),
    USER_SERVER_LIMIT: z.coerce.number().int().min(0).max(20).default(3),
    SERVERS_FILE: z.string().default("./servers/servers.json"),
    DOCKER_PROXY_URL: z.string().default(""),
    LOCAL_SERVER_NAME: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).default("server-milo"),
    MILO_SESSION_IDLE_HOURS: z.coerce.number().positive().default(6),
    MILO_SESSION_MAX_TURNS: z.coerce.number().int().min(4).default(40),

    STT_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
    STT_API_KEY: z.string().default(""),
    STT_MODEL: z.string().default("whisper-large-v3-turbo"),
    STT_USD_PER_HOUR: z.coerce.number().default(0.04),
    VOICE_MAX_SECONDS: z.coerce.number().int().default(300),

    PAYMENT_MODE: z.enum(["bypass", "instanpay"]).default("bypass"),
    INSTANPAY_API_KEY: z.string().default(""),
    INSTANPAY_BASE_URL: z.string().default("https://pay.instanlive.id/api/v1"),
    INSTANPAY_SANDBOX_AUTOPAY_MS: z.coerce.number().int().default(5000),
    PAYMENT_BYPASS_DELAY_MS: z.coerce.number().int().default(3000),
    PAYMENT_EXPIRY_MINUTES: z.coerce.number().int().min(5).default(30),
    PRICE_PROFESIONAL_IDR: z.coerce.number().int().positive().default(500_000),
    PRICE_PENDIRI_IDR: z.coerce.number().int().positive().default(400_000),
    GRACE_DAYS: z.coerce.number().int().min(0).default(3),

    TRIAL_DAYS: z.coerce.number().int().positive().default(14),
    TRIAL_NUDGE_DAY: z.coerce.number().int().positive().default(11),
    QUOTA_TRIAL_TURNS: z.coerce.number().int().positive().default(220),
    QUOTA_PAID_TURNS: z.coerce.number().int().positive().default(600),

    ADMIN_TOKEN: z.string().min(24),
  })
  .superRefine((env, ctx) => {
    const need = (key: keyof typeof env, message: string) => {
      if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message });
    };
    if (env.WA_PROVIDER === "meta") {
      if (env.WA_VERIFY_TOKEN.length < 8) {
        ctx.addIssue({ code: "custom", path: ["WA_VERIFY_TOKEN"], message: "minimal 8 karakter" });
      }
      if (!env.WA_DRY_RUN) {
        for (const key of ["WA_PHONE_NUMBER_ID", "WA_ACCESS_TOKEN", "WA_APP_SECRET"] as const) {
          need(key, "wajib diisi untuk WA_PROVIDER=meta kecuali WA_DRY_RUN=true");
        }
      }
    }
    if (env.FONNTE_WEBHOOK_SECRET && env.FONNTE_WEBHOOK_SECRET.length < 16) {
      ctx.addIssue({ code: "custom", path: ["FONNTE_WEBHOOK_SECRET"], message: "minimal 16 karakter" });
    }
    if (env.PAYMENT_MODE === "instanpay" && !/^sk_(test|live)_/.test(env.INSTANPAY_API_KEY)) {
      ctx.addIssue({
        code: "custom",
        path: ["INSTANPAY_API_KEY"],
        message: "wajib diisi untuk PAYMENT_MODE=instanpay (sk_test_… atau sk_live_…)",
      });
    }
    if (env.SERVER_KEY_SECRET && env.SERVER_KEY_SECRET.length < 32) {
      ctx.addIssue({ code: "custom", path: ["SERVER_KEY_SECRET"], message: "minimal 32 karakter (openssl rand -hex 32)" });
    }
    if (env.GOOGLE_CLIENT_ID) {
      need("GOOGLE_CLIENT_SECRET", "wajib diisi bila GOOGLE_CLIENT_ID diisi");
      need("SERVER_KEY_SECRET", "wajib diisi untuk menyimpan token Google secara terenkripsi (openssl rand -hex 32)");
    }
    if (env.SERVER_ACCESS === "all") {
      need("SERVER_KEY_SECRET", "wajib diisi untuk SERVER_ACCESS=all (openssl rand -hex 32); jangan diganti setelah dipakai");
    }
    if (env.WA_PROVIDER === "fonnte") {
      need("FONNTE_WEBHOOK_SECRET", "wajib diisi untuk WA_PROVIDER=fonnte (openssl rand -hex 16)");
      if (!env.WA_DRY_RUN) need("FONNTE_TOKEN", "wajib diisi untuk WA_PROVIDER=fonnte kecuali WA_DRY_RUN=true");
    }
  });

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    console.error(`Konfigurasi tidak valid:\n${lines.join("\n")}`);
    process.exit(1);
  }
  return parsed.data;
}

export const config = load();
