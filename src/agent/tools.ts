import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config.js";
import { getUser, sql, type UserRow } from "../db/index.js";
import {
  DEFAULT_ASSISTANT_NAME,
  findPersona,
  normalizeAssistantName,
  PERSONAS,
  STANDARD_PERSONA_ID,
} from "../persona/catalog.js";
import { CheckInputError, CHECKS, DOCKER_CHECKS, runCheck } from "../servers/checks.js";
import { ServerSetupError } from "../servers/keys.js";
import { serverToolsFor } from "../servers/registry.js";
import { SshError } from "../servers/ssh.js";
import {
  addUserServer,
  listUserServers,
  recordCheckOutcome,
  removeUserServer,
  resolveServer,
  summarizeServers,
} from "../servers/userServers.js";
import { findAction, listActions, serverActionsFor, type ServerRunPayload } from "../servers/actions.js";
import { ACTION_MINUTES, createAction } from "../actions/pending.js";
import { cancelReminder, createReminder, listReminders } from "../reminders/store.js";
import { alignFirst, formatRepeat, parseRepeat, RepeatError, type Repeat } from "../reminders/repeat.js";
import { errorMessage, formatDate, formatDateTime, normalizePhone } from "../util.js";
import { CONFIRM_MINUTES, draftRelay, messageSendFor, RelayError } from "../relay/service.js";
import { uploadUrlFor } from "../uploads/links.js";
import { normalizeCallName, normalizeWork, parseClock, updateProfile } from "../profile/profile.js";
import type { RoutineKind } from "../routines/routines.js";
import { getAccount, googleEnabled, GoogleAuthError, SCOPE } from "../google/client.js";
import { searchGoogleContacts } from "../google/contacts.js";
import { googleHandlers, googleInputs, googleToolDefs } from "./googleTools.js";
import { notionHandlers, notionInputs, notionToolDefs } from "./notionTools.js";
import { webHandlers, webInputs, webToolDefs } from "./webTools.js";
import { DIRECTIONS_TOOL_DEF, LOCATION_LINK_TOOL_DEF, mapsHandlers, mapsInputs, mapsToolDefs } from "./mapsTools.js";
import { addRule, forgetRule } from "../profile/rules.js";
import { closeSessions } from "./session.js";

type BetaTool = Anthropic.Beta.BetaTool;
type ToolResultContent = Exclude<Anthropic.Beta.BetaToolResultBlockParam["content"], undefined>;

export interface ToolContext {
  user: UserRow;
}

export interface ToolOutcome {
  content: ToolResultContent;
  isError?: boolean;
}

const byName = (a: BetaTool, b: BetaTool) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Sorted by name and never varied per request: tools render first in the prompt, so any change here misses the cache. */
export const TOOL_DEFS: BetaTool[] = (
  [
    {
      name: "account_status",
      description: "Get the user's Milo plan, until when it is active, and how much of this period's fair-use allowance is used.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "capture_read",
      description:
        "Read a saved file or note by id. Text is returned in slices: pass offset to continue. For photos, the image itself is returned so you can look at it.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "integer", description: "Capture id, e.g. 12 for #12." },
          offset: { type: "integer", description: "Character offset to start from. Default 0." },
          max_chars: { type: "integer", description: "Characters to return, 500–30000. Default 8000." },
        },
        required: ["id"],
      },
    },
    {
      name: "capture_search",
      description:
        "Search the documents, photos, voice-note transcripts and forwarded texts the user has sent. Returns ids, titles and matching snippets. An empty query lists the most recent items.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords in the language of the document. May be empty." },
          limit: { type: "integer", description: "1–10. Default 5." },
        },
        required: ["query"],
      },
    },
    {
      name: "contact_find",
      description:
        "Find a person by name, nickname/role (e.g. 'PM') or phone number. Searches the people the user has saved here, and — when Google Contacts is connected — their own Google contacts, saving what it finds. Always try this before asking the user for a number.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "contact_save",
      description:
        "Save or update a person in the user's contacts. Use alias for how the user refers to them (e.g. 'PM', 'istri', 'Pak Direktur'). Phone numbers may be in 08xx or +62 form.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          phone: { type: "string" },
          alias: { type: "string" },
          email: { type: "string" },
        },
        required: ["name"],
      },
    },
    {
      name: "fact_remember",
      description: "Remember a durable fact about the user or their work for future conversations. One fact per call, in one sentence.",
      input_schema: {
        type: "object",
        properties: { fact: { type: "string" } },
        required: ["fact"],
      },
    },
    {
      name: "style_rule",
      description: [
        "Record how this user wants you to work, the moment they correct you: \"jangan panjang-panjang\", \"jangan pakai emoji\", \"kalau soal uang sebutkan angkanya\", \"balas pakai bahasa Inggris saja\". Write it as one short instruction to yourself, in the user's own language, e.g. \"Jawab singkat, maksimal dua kalimat\".",
        "This is for how you behave. What is true about the user or their world is fact_remember, and their name, work, answer length and check-in times have their own fields in profile_update; use those instead of a rule when they fit.",
        "Set forget=true with roughly the words of the rule to drop one they no longer want. Confirm in one short sentence, and never argue with a correction.",
      ].join("\n\n"),
      input_schema: {
        type: "object",
        properties: {
          rule: { type: "string" },
          forget: { type: "boolean" },
        },
        required: ["rule"],
      },
    },
    {
      name: "fact_forget",
      description: "Forget remembered facts when the user asks. Deletes the facts containing the given words and returns what was removed.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "Words that appear in the fact to forget." } },
        required: ["query"],
      },
    },
    DIRECTIONS_TOOL_DEF,
    LOCATION_LINK_TOOL_DEF,
    {
      name: "persona_set",
      description: [
        "Change your own name and/or personality when the user asks, e.g. after they reply to the GAYA menu (\"yang ceria saja, namanya Yuki\") or say \"ganti nama kamu jadi Sari\". The user picks a style by what it is called or by how it sounds, never by a number. Give only what they want to change; the other stays as is. persona=standar returns to the standard style.",
        "When the user asks what styles exist, suggest typing GAYA to see the full menu with examples.",
        `The styles (id · label · what it sounds like · gender · suggested name):\n${PERSONAS.map((p) => `${p.id} · ${p.label} · ${p.tagline} · ${p.gender} · ${p.suggestedName}`).join("\n")}`,
      ].join("\n\n"),
      input_schema: {
        type: "object",
        properties: {
          persona: { type: "string", enum: [STANDARD_PERSONA_ID, ...PERSONAS.map((p) => p.id)] },
          name: { type: "string", description: "The name the user gives you, up to 30 characters." },
        },
      },
    },
    {
      name: "profile_update",
      description:
        "Save how the user wants you to work with them. Give only the fields they changed. answer_style: singkat, lengkap, or standar to clear. The three check-ins you send on your own (morning agenda, lunch break on weekdays, end-of-day on weekdays) take HH:MM in their time zone to move them, off to stop them, or on for the default time. The change applies from your next reply; confirm it briefly.",
      input_schema: {
        type: "object",
        properties: {
          call_name: { type: "string", description: "How to address the user, e.g. Pak Josh, Bu Rina, Bos." },
          work: { type: "string", description: "Their business or job, in their words." },
          answer_style: { type: "string", enum: ["singkat", "lengkap", "standar"] },
          morning_briefing: { type: "string", description: "Morning check-in with the day's agenda: HH:MM, on, or off. Default 07:30." },
          lunch_reminder: { type: "string", description: "Weekday nudge to break for lunch: HH:MM, on, or off. Default 12:00." },
          evening_checkin: { type: "string", description: "Weekday end-of-day look at tomorrow: HH:MM, on, or off. Default 17:30." },
        },
      },
    },
    {
      name: "reminder_cancel",
      description: "Cancel a scheduled reminder by id. Cancelling a repeating reminder stops the whole series.",
      input_schema: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
      },
    },
    {
      name: "reminder_create",
      description: "Schedule a WhatsApp reminder for the user, once or repeating.",
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to remind the user about, phrased as the reminder they will read." },
          at: { type: "string", description: "First occurrence, ISO 8601 with UTC offset, e.g. 2026-09-18T09:00:00+07:00." },
          repeat: {
            type: "string",
            description:
              "Only for a repeating reminder. An RRULE: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, with optional INTERVAL, BYDAY (weekly, MO TU WE TH FR SA SU), BYMONTHDAY, BYMONTH. Examples: FREQ=DAILY; FREQ=WEEKLY;BYDAY=MO,TH; FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR; FREQ=WEEKLY;INTERVAL=2;BYDAY=FR; FREQ=MONTHLY;BYMONTHDAY=25; FREQ=YEARLY. Every occurrence keeps the time of day of the first one.",
          },
          until: { type: "string", description: "Optional last day of a repeating reminder, ISO 8601 with UTC offset." },
        },
        required: ["text", "at"],
      },
    },
    {
      name: "reminder_list",
      description: "List the user's upcoming reminders, including how each repeating one repeats.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "upload_link",
      description:
        "Get the user's private link for sending files (PDF, Word, text, photos, voice recordings) through the browser; files sent there are saved like files sent in chat and you are told when they arrive. Files and voice notes sent inside this WhatsApp chat may not reach you, so give this link whenever the user wants to send a file, or mentions a file or photo you have not received. Send the link as plain text. The user can also type FILE to get it.",
      input_schema: { type: "object", properties: {} },
    },
  ] satisfies BetaTool[]
).sort(byName);

const SERVER_NAME_HINT = "Short name: lowercase letters, digits and dashes (e.g. toko, vps-kantor).";

/**
 * The same bytes for every user who has server access, so their prompt prefixes can share a cache entry. Which
 * servers a user can reach is decided at call time, never in these definitions.
 */
export const SERVER_TOOL_DEFS: BetaTool[] = [
  {
    name: "server_add",
    description: [
      "Connect one of the user's own Linux servers so Milo can check it. Milo creates a dedicated SSH key for it; nobody ever needs to share a password. If the user offers a server password, do not use or repeat it; tell them it is not needed and that they should change it if they already sent it.",
      "Ask for the address (IP or domain), SSH port if not 22, and the SSH username if you do not have them. Only servers reachable from the internet are supported.",
      "The result contains a one-line install command. Send it to the user inside a ``` block, tell them to run it on that server while logged in as that user, and to tell you when done; then run server_check with check=overview to confirm the connection.",
      "Calling it again for a server that is not connected yet keeps the same key and updates the address.",
    ].join("\n\n"),
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: SERVER_NAME_HINT },
        host: { type: "string", description: "Public IP address or domain." },
        port: { type: "integer", description: "SSH port. Default 22." },
        user: { type: "string", description: "SSH username on that server." },
        description: { type: "string", description: "What runs there, in the user's words." },
      },
      required: ["name", "host", "user"],
    },
  },
  {
    name: "server_check",
    description: [
      "Inspect one of the user's servers, read-only. Nothing here can restart, deploy, edit or delete anything on the server; if the user asks for that, say Milo cannot do it yet and tell them what to run or who should do it.",
      "Checks: overview (load, memory, disk, top processes, failed services), disk, memory, processes, containers (status and CPU/RAM per container), services (failed and running systemd services), service_status (target = unit, e.g. nginx), error_logs (system errors in the last 24h), ports (listening TCP ports), http (url = address to request from that server).",
      "Logs: container_logs (target = container), compose_logs (target = absolute folder of the docker-compose project, optional service), service_logs (target = systemd unit), pm2_logs (target = pm2 process), file_logs (target = absolute path of a log file). Set only_errors when the user asks what went wrong. If you do not know where an app logs, look at containers or services first, or ask the user.",
      "Use server_list for the servers this user has and which checks each supports. Start with overview when the user asks generally whether a server is fine; several checks can run in parallel.",
      "The user is not technical: answer with the verdict first (aman / perlu perhatian / bermasalah), then the few facts that matter, then what to do. Quote at most a few short log lines, and only when they help.",
    ].join("\n\n"),
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string" },
        check: { type: "string", enum: [...CHECKS] },
        target: { type: "string" },
        service: { type: "string", description: "compose_logs only: one service of the project." },
        url: { type: "string", description: "http only: the full http(s) URL." },
        lines: { type: "integer", description: "Log lines, 10–300. Default 80." },
        only_errors: { type: "boolean", description: "Log checks only: keep lines that look like errors, from a wider window." },
      },
      required: ["server", "check"],
    },
  },
  {
    name: "server_list",
    description:
      "List the servers this user can check, with their connection status, which checks each supports, and known app log locations.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "server_run",
    description: [
      "Run one of the user's saved server actions, by name — a deploy, a restart, a script they set up earlier. Use server_actions to see what exists on which server.",
      "Nothing runs from this call: right after your reply the user sees the exact command with a Jalankan button, and it runs only if they tap it. Say in one short sentence what is waiting for their confirmation.",
      "You cannot write a command yourself. If there is no saved action for what they want, say so and tell them how to make one: they send `aksi <server> <nama>: <perintah>` to save it, or `jalankan di <server>: <perintah>` to run it once. You may suggest the exact command text in your reply for them to send.",
    ].join("\n\n"),
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string", description: SERVER_NAME_HINT },
        action: { type: "string", description: "The saved action name, e.g. deploy." },
      },
      required: ["server", "action"],
    },
  },
  {
    name: "server_actions",
    description: "List the saved actions for one of the user's servers, or for all of them when server is omitted: what each one is called and what it does.",
    input_schema: {
      type: "object",
      properties: { server: { type: "string", description: SERVER_NAME_HINT } },
    },
  },
  {
    name: "server_remove",
    description:
      "Disconnect one of the user's servers from Milo and delete Milo's key for it. Only when the user asks. Afterwards, tell them they can also delete the line ending in that server's name from ~/.ssh/authorized_keys on the server.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
];

/** Same bytes for everyone who may send messages; only offered on channels and to users allowed by config. */
export const MESSAGE_SEND_TOOL_DEF: BetaTool = {
  name: "message_send",
  description: [
    "Send a WhatsApp message to another person on the user's behalf, from your own number. Nothing is sent by this call: right after your reply, the user sees the exact message with Kirim and Batal buttons, and it is sent only if they tap Kirim.",
    "Write the message as the user's assistant, in the recipient's language: greet them, introduce yourself by your name as the user's assistant, then say what the user wants clearly and politely. Do not add a signature; one is appended automatically.",
    "One recipient per call. Give contact_id (from contact_find or contact_save) or phone. Calling again replaces the draft that is still waiting.",
    "In your reply, say in one short sentence that the message is ready for their confirmation; do not repeat its text. If the recipient answers, their reply reaches the user directly and appears in a later turn as [Balasan dari ...].",
  ].join("\n\n"),
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The message body, up to 1500 characters." },
      contact_id: { type: "integer" },
      phone: { type: "string" },
    },
    required: ["text"],
  },
};

const toolSets = new Map<string, BetaTool[]>();

export function toolsFor(user: UserRow): BetaTool[] {
  const servers = serverToolsFor(user.waId);
  const messaging = messageSendFor(user.waId);
  const google = googleToolDefs();
  const web = webToolDefs();
  const maps = mapsToolDefs();
  const notion = notionToolDefs();
  if (!servers && !messaging && !google.length && !web.length && !maps.length && !notion.length) return TOOL_DEFS;
  const key = `${servers ? "s" : ""}${messaging ? "m" : ""}${web.length ? "w" : ""}${maps.length ? "p" : ""}${notion.length ? "n" : ""}${google.map((t) => t.name).join(",")}`;
  let tools = toolSets.get(key);
  if (!tools) {
    tools = [
      ...TOOL_DEFS,
      ...(servers ? SERVER_TOOL_DEFS : []),
      ...(messaging ? [MESSAGE_SEND_TOOL_DEF] : []),
      ...google,
      ...web,
      ...maps,
      ...notion,
    ].sort(byName);
    toolSets.set(key, tools);
  }
  return tools;
}

type Recipient = { to: string; name: string | null };

async function resolveRecipient(user: UserRow, contactId: number | undefined, phone: string | undefined): Promise<Recipient | string> {
  if (contactId) {
    const [c] = await sql<{ name: string; phone: string | null }[]>`
      select name, phone from contacts where id = ${contactId} and user_id = ${user.id}
    `;
    if (!c) return `Kontak #${contactId} tidak ditemukan.`;
    if (!c.phone) return `Kontak ${c.name} belum punya nomor. Minta pengguna mengirim nomornya atau membagikan kartu kontaknya.`;
    return { to: c.phone, name: c.name };
  }
  if (phone) {
    const to = normalizePhone(phone);
    if (!to) return `Nomor "${phone}" tidak valid.`;
    const [c] = await sql<{ name: string }[]>`select name from contacts where user_id = ${user.id} and phone = ${to}`;
    return { to, name: c?.name ?? null };
  }
  return "Sebutkan penerimanya: contact_id atau phone.";
}

const inputs = {
  ...googleInputs,
  ...notionInputs,
  ...webInputs,
  ...mapsInputs,
  account_status: z.object({}).loose(),
  capture_read: z.object({
    id: z.coerce.number().int().positive(),
    offset: z.coerce.number().int().min(0).optional(),
    max_chars: z.coerce.number().int().optional(),
  }),
  capture_search: z.object({
    query: z.string().max(300),
    limit: z.coerce.number().int().optional(),
  }),
  contact_find: z.object({ query: z.string().min(1).max(100) }),
  contact_save: z.object({
    name: z.string().min(1).max(120),
    phone: z.string().max(40).optional(),
    alias: z.string().max(60).optional(),
    email: z.string().max(200).optional(),
  }),
  fact_remember: z.object({ fact: z.string().min(3).max(300) }),
  fact_forget: z.object({ query: z.string().min(2).max(100) }),
  style_rule: z.object({ rule: z.string().min(3).max(160), forget: z.boolean().optional() }),
  profile_update: z.object({
    call_name: z.string().max(60).optional(),
    work: z.string().max(300).optional(),
    answer_style: z.enum(["singkat", "lengkap", "standar"]).optional(),
    morning_briefing: z.string().max(20).optional(),
    lunch_reminder: z.string().max(20).optional(),
    evening_checkin: z.string().max(20).optional(),
  }),
  message_send: z.object({
    text: z.string().min(1).max(1500),
    contact_id: z.coerce.number().int().positive().optional(),
    phone: z.string().max(40).optional(),
  }),
  persona_set: z.object({
    persona: z.string().max(40).optional(),
    name: z.string().max(60).optional(),
  }),
  reminder_cancel: z.object({ id: z.coerce.number().int().positive() }),
  reminder_create: z.object({
    text: z.string().min(1).max(500),
    at: z.string().min(10).max(40),
    repeat: z.string().max(120).optional(),
    until: z.string().min(10).max(40).optional(),
  }),
  reminder_list: z.object({}).loose(),
  upload_link: z.object({}).loose(),
  server_add: z.object({
    name: z.string().min(1).max(40),
    host: z.string().min(1).max(255),
    port: z.coerce.number().int().optional(),
    user: z.string().min(1).max(32),
    description: z.string().max(300).optional(),
  }),
  server_check: z.object({
    server: z.string().min(1).max(40),
    check: z.enum(CHECKS),
    target: z.string().max(300).optional(),
    service: z.string().max(128).optional(),
    url: z.string().max(500).optional(),
    lines: z.coerce.number().int().optional(),
    only_errors: z.union([z.boolean(), z.stringbool()]).optional(),
  }),
  server_list: z.object({}).loose(),
  server_run: z.object({ server: z.string().min(1).max(40), action: z.string().min(1).max(30) }),
  server_actions: z.object({ server: z.string().max(40).optional() }),
  server_remove: z.object({ name: z.string().min(1).max(40) }),
} as const;

type ToolName = keyof typeof inputs;

const ok = (value: unknown): ToolOutcome => ({ content: typeof value === "string" ? value : JSON.stringify(value) });
const fail = (message: string): ToolOutcome => ({ content: message, isError: true });

const NO_SERVER_ACCESS = "Fitur cek server belum tersedia untuk pengguna ini.";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 3_750_000;

async function periodUsage(user: UserRow): Promise<{ since: Date; turns: number }> {
  const since =
    user.plan === "trial" && user.trialEndsAt
      ? new Date(user.trialEndsAt.getTime() - config.TRIAL_DAYS * 86_400_000)
      : new Date(Date.now() - 30 * 86_400_000);
  const [row] = await sql<{ n: string }[]>`
    select count(*) as n from agent_runs where user_id = ${user.id} and created_at >= ${since}
  `;
  return { since, turns: Number(row?.n ?? 0) };
}

export async function quotaState(user: UserRow): Promise<{ used: number; limit: number; exceeded: boolean }> {
  const limit = user.plan === "trial" ? config.QUOTA_TRIAL_TURNS : config.QUOTA_PAID_TURNS;
  const { turns } = await periodUsage(user);
  return { used: turns, limit, exceeded: turns >= limit };
}

interface ContactInput {
  name: string;
  phone: string | null;
  alias: string | null;
  email: string | null;
}

/** One person per phone number; a contact without a number is matched by name instead. */
async function saveContact(user: UserRow, c: ContactInput): Promise<string | undefined> {
  if (c.phone) {
    const [row] = await sql<{ id: string }[]>`
      insert into contacts (user_id, name, alias, phone, email)
      values (${user.id}, ${c.name}, ${c.alias}, ${c.phone}, ${c.email})
      on conflict (user_id, phone) do update
        set name = excluded.name,
            alias = coalesce(excluded.alias, contacts.alias),
            email = coalesce(excluded.email, contacts.email)
      returning id
    `;
    return row?.id;
  }
  const [existing] = await sql<{ id: string }[]>`
    select id from contacts where user_id = ${user.id} and lower(name) = lower(${c.name}) order by id desc limit 1
  `;
  if (existing) {
    await sql`update contacts set alias = coalesce(${c.alias}, alias), email = coalesce(${c.email}, email) where id = ${existing.id}`;
    return existing.id;
  }
  const [row] = await sql<{ id: string }[]>`
    insert into contacts (user_id, name, alias, email) values (${user.id}, ${c.name}, ${c.alias}, ${c.email}) returning id
  `;
  return row?.id;
}

/** Whether this user's Google contacts can be searched right now. */
async function googleContactsReady(user: UserRow): Promise<boolean> {
  if (!googleEnabled()) return false;
  const account = await getAccount(user.id);
  return account?.status === "active" && account.scopes.includes(SCOPE.contacts);
}

const handlers: { [K in ToolName]: (ctx: ToolContext, input: z.infer<(typeof inputs)[K]>) => Promise<ToolOutcome> } = {
  ...googleHandlers,
  ...notionHandlers,
  ...webHandlers,
  ...mapsHandlers,
  async account_status({ user }) {
    const quota = await quotaState(user);
    const tz = user.timezone;
    return ok({
      plan: user.plan,
      status: user.status,
      trial_ends: user.trialEndsAt ? formatDate(user.trialEndsAt, tz) : null,
      active_until: user.periodEndsAt ? formatDate(user.periodEndsAt, tz) : null,
      fair_use: `${quota.used} dari ${quota.limit} percakapan pada periode ini`,
      note: "Jangan sebutkan angka fair use kecuali pengguna menanyakannya langsung.",
    });
  },

  async capture_read({ user }, { id, offset = 0, max_chars = 8000 }) {
    const [c] = await sql<
      { id: string; kind: string; title: string; mime: string | null; filePath: string | null; sizeBytes: string | null; pageCount: number | null; textContent: string | null; status: string; createdAt: Date }[]
    >`select * from captures where id = ${id} and user_id = ${user.id}`;
    if (!c) return fail(`Tidak ada file #${id}.`);

    const size = Math.min(Math.max(max_chars, 500), 30_000);
    const text = c.textContent ?? "";
    const header = `#${c.id} ${c.title} (${c.kind}${c.pageCount ? `, ${c.pageCount} hlm` : ""}, ${formatDate(c.createdAt, user.timezone)})`;

    if (c.kind === "image" && c.filePath && c.mime && IMAGE_TYPES.has(c.mime) && Number(c.sizeBytes ?? 0) <= MAX_IMAGE_BYTES) {
      const data = (await readFile(c.filePath)).toString("base64");
      return {
        content: [
          { type: "text", text: `${header}${text ? `\nKeterangan: ${text}` : ""}` },
          { type: "image", source: { type: "base64", media_type: c.mime as "image/jpeg", data } },
        ],
      };
    }
    if (!text) {
      return ok(`${header}\nTidak ada teks yang bisa dibaca dari file ini (status: ${c.status}).`);
    }
    const slice = text.slice(offset, offset + size);
    const end = offset + slice.length;
    const more = end < text.length ? `\nLanjutan tersedia: offset=${end}` : "\n(akhir file)";
    return ok(`${header}\nKarakter ${offset}–${end} dari ${text.length}:\n\n${slice}${more}`);
  },

  async capture_search({ user }, { query, limit = 5 }) {
    const n = Math.min(Math.max(limit, 1), 10);
    const q = query.trim();
    type Hit = { id: string; kind: string; title: string; status: string; createdAt: Date; snippet: string | null };
    let rows: Hit[] = [];
    if (q) {
      rows = await sql<Hit[]>`
        select c.id, c.kind, c.title, c.status, c.created_at,
               ts_headline('simple', left(coalesce(c.text_content, ''), 100000), q,
                           'MaxFragments=2, MaxWords=25, MinWords=8, StartSel=«, StopSel=»') as snippet
        from captures c, websearch_to_tsquery('simple', ${q}) q
        where c.user_id = ${user.id} and c.search @@ q
        order by ts_rank(c.search, q) desc, c.id desc
        limit ${n}
      `;
      if (!rows.length) {
        const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
        rows = await sql<Hit[]>`
          select id, kind, title, status, created_at, left(text_content, 200) as snippet
          from captures
          where user_id = ${user.id} and (title ilike ${like} or text_content ilike ${like})
          order by id desc
          limit ${n}
        `;
      }
    } else {
      rows = await sql<Hit[]>`
        select id, kind, title, status, created_at, left(text_content, 160) as snippet
        from captures where user_id = ${user.id} order by id desc limit ${n}
      `;
    }
    if (!rows.length) return ok(q ? `Tidak ada file yang cocok dengan "${q}".` : "Belum ada file tersimpan.");
    return ok(
      rows.map((r) => ({
        id: Number(r.id),
        kind: r.kind,
        title: r.title,
        saved: formatDate(r.createdAt, user.timezone),
        readable: r.status === "ready",
        snippet: r.snippet?.replace(/\s+/g, " ").trim() || null,
      })),
    );
  },

  async contact_find({ user }, { query }) {
    const like = `%${query.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const digits = normalizePhone(query);
    const rows = await sql<{ id: string; name: string; alias: string | null; phone: string | null; email: string | null }[]>`
      select id, name, alias, phone, email from contacts
      where user_id = ${user.id}
        and (name ilike ${like} or alias ilike ${like} ${digits ? sql`or phone = ${digits}` : sql``})
      order by id desc limit 10
    `;
    if (rows.length) return ok(rows.map((r) => ({ id: Number(r.id), name: r.name, alias: r.alias, phone: r.phone, email: r.email })));

    // Nobody is saved here yet: the user's Google contacts are the address book they already keep.
    if (await googleContactsReady(user)) {
      try {
        const found = await searchGoogleContacts(user.id, query);
        if (found.length) {
          const saved = await Promise.all(
            found.map(async (c) => ({
              id: Number(await saveContact(user, { name: c.name, phone: c.phone, alias: null, email: c.email })),
              name: c.name,
              phone: c.phone,
              email: c.email,
              organization: c.organization,
            })),
          );
          return ok({ from: "Google Kontak", saved_to_user_contacts: true, contacts: saved });
        }
      } catch (err) {
        if (err instanceof GoogleAuthError) {
          return ok(`Tidak ada kontak tersimpan yang cocok dengan "${query}", dan Google Kontak tidak terbaca karena login kedaluwarsa.`);
        }
        throw err;
      }
    }
    return ok(`Tidak ada kontak yang cocok dengan "${query}".`);
  },

  async contact_save({ user }, { name, phone, alias, email }) {
    const normalized = phone ? normalizePhone(phone) : null;
    if (phone && !normalized) return fail(`Nomor "${phone}" tidak valid.`);
    const id = await saveContact(user, { name, phone: normalized, alias: alias ?? null, email: email ?? null });
    return ok({ saved: true, id: Number(id), name, alias: alias ?? null, phone: normalized });
  },

  async style_rule({ user }, { rule, forget }) {
    if (forget) {
      const dropped = await forgetRule(user.id, rule);
      return dropped ? ok({ forgot: dropped.rule }) : ok(`Tidak ada aturan yang cocok dengan "${rule}".`);
    }
    const outcome = await addRule(user.id, rule);
    if (!outcome) return fail("Aturannya terlalu pendek untuk disimpan.");
    if (outcome.status === "same") return ok({ already: outcome.rule });
    return ok({
      [outcome.status === "replaced" ? "replaced" : "added"]: outcome.rule,
      ...(outcome.dropped ? { instead_of: outcome.dropped } : {}),
    });
  },

  async fact_remember({ user }, { fact }) {
    if (/\b(password|kata sandi|pin|otp|cvv)\b/i.test(fact)) {
      return fail("Fakta ini tampak berisi rahasia (kata sandi/PIN/OTP) dan tidak disimpan.");
    }
    await sql`
      insert into facts (user_id, fact)
      select ${user.id}, ${fact}
      where not exists (select 1 from facts where user_id = ${user.id} and lower(fact) = lower(${fact}))
    `;
    await sql`
      delete from facts where user_id = ${user.id}
        and id not in (select id from facts where user_id = ${user.id} order by id desc limit 200)
    `;
    return ok("Tersimpan.");
  },

  async fact_forget({ user }, { query }) {
    const like = `%${query.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const removed = await sql<{ fact: string }[]>`
      delete from facts where id in (
        select id from facts where user_id = ${user.id} and fact ilike ${like} order by id desc limit 10
      )
      returning fact
    `;
    if (!removed.length) return fail(`Tidak ada fakta tersimpan yang memuat "${query}".`);
    await closeSessions(user.id);
    return ok({ forgotten: removed.map((r) => r.fact) });
  },

  async profile_update({ user }, input) {
    const patch: Parameters<typeof updateProfile>[1] = {};
    if (input.call_name !== undefined) {
      const callName = normalizeCallName(input.call_name);
      if (!callName) return fail("Panggilan harus singkat (maks. 4 kata, 40 huruf) tanpa simbol.");
      patch.callName = callName;
    }
    if (input.work !== undefined) {
      const work = normalizeWork(input.work);
      if (!work) return fail("Keterangan pekerjaan harus 2–200 huruf.");
      patch.work = work;
    }
    if (input.answer_style) patch.answerStyle = input.answer_style === "standar" ? null : input.answer_style;
    // Read fresh: an earlier call in the same turn may already have changed them.
    const routines = { ...((await getUser(user.id))?.profile?.routines ?? {}) };
    const fields: [RoutineKind, string | undefined, string][] = [
      ["morning", input.morning_briefing, "sapaan pagi"],
      ["lunch", input.lunch_reminder, "pengingat makan siang"],
      ["evening", input.evening_checkin, "sapaan sore"],
    ];
    for (const [kind, value, label] of fields) {
      if (value === undefined) continue;
      const v = value.trim();
      if (/^(off|mati|tidak|stop|jangan)$/i.test(v)) routines[kind] = "off";
      else if (/^(on|nyala|aktif|ya)$/i.test(v)) delete routines[kind];
      else {
        const time = parseClock(v);
        if (!time) return fail(`Jam ${label} harus berformat HH:MM, misalnya 07:00, atau on/off.`);
        routines[kind] = time;
      }
    }
    if (fields.some(([, value]) => value !== undefined)) {
      patch.routines = routines;
      // The old morning setting stops mattering once the morning check-in has its own.
      if (input.morning_briefing !== undefined) patch.briefingTime = null;
    }
    if (!Object.keys(patch).length) return fail("Tidak ada yang diubah.");
    const profile = await updateProfile(user.id, patch);
    await closeSessions(user.id);
    return ok({ saved: profile, note: "Berlaku mulai balasan berikutnya." });
  },

  async message_send({ user }, { text, contact_id, phone }) {
    if (!messageSendFor(user.waId)) return fail("Mengirim pesan langsung belum tersedia untuk pengguna ini. Pakai message_draft.");
    const recipient = await resolveRecipient(user, contact_id, phone);
    if (typeof recipient === "string") return fail(recipient);
    try {
      const draft = await draftRelay(user, { toWa: recipient.to, contactName: recipient.name, body: text });
      return ok({
        status: "menunggu konfirmasi pengguna",
        to: recipient.name ? `${recipient.name} (${recipient.to})` : recipient.to,
        expires_in_minutes: CONFIRM_MINUTES,
        draft_id: Number(draft.id),
      });
    } catch (err) {
      if (err instanceof RelayError) return fail(err.message);
      throw err;
    }
  },

  async persona_set({ user }, { persona, name }) {
    if (!persona && !name?.trim()) return fail("Sebutkan gaya (persona) atau nama yang diinginkan pengguna.");
    let chosen = findPersona(user.persona);
    if (persona) {
      if (persona === STANDARD_PERSONA_ID) {
        chosen = undefined;
      } else {
        chosen = findPersona(persona);
        if (!chosen) return fail(`Gaya "${persona}" tidak ada. Pilihan: ${PERSONAS.map((p) => p.id).join(", ")}, atau ${STANDARD_PERSONA_ID}.`);
      }
    }
    let assistantName = user.assistantName ?? DEFAULT_ASSISTANT_NAME;
    if (name?.trim()) {
      const normalized = normalizeAssistantName(name);
      if (!normalized) {
        return fail("Nama hanya boleh berisi huruf, angka, spasi, titik, apostrof atau tanda minus, paling panjang 30 karakter.");
      }
      assistantName = normalized;
    }
    await sql`
      update users set assistant_name = ${assistantName}, persona = ${chosen?.id ?? null}, updated_at = now()
      where id = ${user.id}
    `;
    await closeSessions(user.id);
    return ok({
      saved: { name: assistantName, style: chosen ? `${chosen.label} (${chosen.gender})` : "standar" },
      instruction: `From this reply on, you are ${assistantName}${
        chosen ? `, speaking in the ${chosen.label} style: ${chosen.style} Example: "${chosen.sample}"` : ", speaking in the standard style"
      } Confirm the change in one or two sentences in that voice, and mention they can type GAYA to change it again.`,
    });
  },

  async reminder_cancel({ user }, { id }) {
    const result = await cancelReminder(user, id);
    if (!result.cancelled) return fail(`Tidak ada pengingat aktif #${id}.`);
    return ok(result.repeat ? `Pengingat berulang #${id} dihentikan, termasuk jadwal berikutnya.` : `Pengingat #${id} dibatalkan.`);
  },

  async reminder_create({ user }, { text, at, repeat, until }) {
    if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(at.trim())) {
      return fail("Waktu harus ISO 8601 lengkap dengan offset zona waktu, mis. 2026-09-18T09:00:00+07:00.");
    }
    let fireAt = new Date(at);
    if (Number.isNaN(fireAt.getTime())) return fail(`Waktu "${at}" tidak bisa dibaca.`);

    let rule: Repeat | undefined;
    let stopAt: Date | undefined;
    if (repeat) {
      try {
        const parsed = parseRepeat(repeat);
        rule = parsed.rule;
        stopAt = parsed.until;
      } catch (err) {
        return fail(err instanceof RepeatError ? err.message : errorMessage(err));
      }
      const aligned = alignFirst(rule, fireAt, user.timezone);
      if (!aligned) return fail("Pengulangan itu tidak pernah jatuh pada tanggal mana pun.");
      fireAt = aligned;
    }
    if (until) {
      const end = new Date(until);
      if (Number.isNaN(end.getTime())) return fail(`Batas akhir "${until}" tidak bisa dibaca.`);
      stopAt = end;
    }

    const now = Date.now();
    if (fireAt.getTime() < now + 30_000) return fail("Waktu pengingat sudah lewat atau terlalu dekat.");
    if (!rule && fireAt.getTime() > now + 366 * 86_400_000) return fail("Pengingat sekali jalan maksimal satu tahun ke depan.");
    if (stopAt && stopAt.getTime() < fireAt.getTime()) return fail("Batas akhir pengulangan jatuh sebelum pengingat pertama.");

    const created = await createReminder(user, { text, fireAt, ...(rule ? { rule } : {}), ...(stopAt ? { until: stopAt } : {}) });
    const when = formatDateTime(fireAt, user.timezone);
    if (!rule) return ok(`Pengingat #${created.id} dijadwalkan: ${when}.`);
    const ends = stopAt ? `, sampai ${formatDate(stopAt, user.timezone)}` : "";
    return ok(`Pengingat berulang #${created.id} dijadwalkan ${created.label}${ends}. Yang pertama: ${when}.`);
  },

  async reminder_list({ user }) {
    const rows = await listReminders(user);
    if (!rows.length) return ok("Tidak ada pengingat yang dijadwalkan.");
    return ok(
      rows.map((r) => ({
        id: Number(r.id),
        when: formatDateTime(r.fireAt, user.timezone),
        text: r.text,
        ...(r.repeat ? { repeat: formatRepeat(parseRepeat(r.repeat).rule, r.fireAt, user.timezone) } : {}),
        ...(r.repeatUntil ? { until: formatDate(r.repeatUntil, user.timezone) } : {}),
      })),
    );
  },

  async upload_link({ user }) {
    const url = uploadUrlFor(user.id);
    if (!url) return fail("Link unggah belum tersedia karena alamat publik Milo belum diketahui. Minta pengguna mencoba lagi sebentar lagi.");
    return ok({ url, valid_hours: config.UPLOAD_LINK_HOURS });
  },

  async server_add({ user }, input) {
    if (!serverToolsFor(user.waId)) return fail(NO_SERVER_ACCESS);
    try {
      const added = await addUserServer(user, input);
      return ok({
        server: added.name,
        status: "menunggu kunci dipasang",
        install_command: added.installCommand,
        note: added.reused
          ? "Alamat diperbarui; kuncinya sama seperti sebelumnya, jadi kalau sudah dipasang tidak perlu dipasang lagi."
          : `Perintah ini hanya menambahkan public key Milo untuk user ${input.user}. Setelah dijalankan, cek dengan server_check overview.`,
      });
    } catch (err) {
      if (err instanceof ServerSetupError) return fail(err.message);
      throw err;
    }
  },

  async server_check({ user }, { only_errors, ...input }) {
    if (!serverToolsFor(user.waId)) return fail(NO_SERVER_ACCESS);
    let resolved: Awaited<ReturnType<typeof resolveServer>>;
    try {
      resolved = await resolveServer(user, input.server);
    } catch (err) {
      if (err instanceof ServerSetupError) return fail(err.message);
      throw err;
    }
    if (!resolved) return fail(`Server "${input.server}" tidak ada. Lihat server_list, atau hubungkan dulu dengan server_add.`);
    try {
      const out = await runCheck(resolved.target, { ...input, onlyErrors: only_errors });
      if (resolved.rowId) await recordCheckOutcome(resolved.rowId, null);
      return ok(out);
    } catch (err) {
      if (err instanceof CheckInputError) return fail(err.message);
      const message = err instanceof Error ? err.message : String(err);
      if (resolved.rowId && err instanceof SshError) await recordCheckOutcome(resolved.rowId, message);
      return fail(`Cek ${input.check} di ${input.server} gagal: ${message}`);
    }
  },

  async server_list({ user }) {
    if (!serverToolsFor(user.waId)) return fail(NO_SERVER_ACCESS);
    const servers = await summarizeServers(user, DOCKER_CHECKS);
    return ok(servers.length ? servers : "Belum ada server. Hubungkan dengan server_add.");
  },

  async server_run({ user }, { server, action }) {
    if (!serverToolsFor(user.waId)) return fail(NO_SERVER_ACCESS);
    if (!serverActionsFor(user.waId)) return fail("Menjalankan perintah di server belum diaktifkan untuk pengguna ini.");
    const saved = await findAction(user, server, action);
    if (!saved) {
      const known = await listActions(user, server);
      return fail(
        known.length
          ? `Server "${server}" tidak punya aksi "${action}". Yang ada: ${known.map((a) => a.name).join(", ")}.`
          : `Server "${server}" belum punya aksi tersimpan. Pengguna bisa membuatnya dengan: aksi ${server} <nama>: <perintah>`,
      );
    }
    const payload: ServerRunPayload = { server: server.trim().toLowerCase(), action: saved.name, command: saved.command, timeoutSec: saved.timeoutSec };
    const pending = await createAction(user.id, "server_run", payload);
    return ok({
      status: "menunggu konfirmasi pengguna",
      server: payload.server,
      action: saved.name,
      expires_in_minutes: ACTION_MINUTES,
      draft_id: Number(pending.id),
    });
  },

  async server_actions({ user }, { server }) {
    if (!serverToolsFor(user.waId)) return fail(NO_SERVER_ACCESS);
    const names = server ? [server.trim().toLowerCase()] : (await listUserServers(user.id)).map((r) => r.name);
    const out: { server: string; action: string; description: string; command: string }[] = [];
    for (const name of names) {
      for (const a of await listActions(user, name)) {
        out.push({ server: name, action: a.name, description: a.description, command: a.command });
      }
    }
    if (!out.length) {
      return ok(
        `Belum ada aksi tersimpan${server ? ` untuk server "${server}"` : ""}. Pengguna membuatnya sendiri dengan: aksi <server> <nama>: <perintah>`,
      );
    }
    return ok(out);
  },

  async server_remove({ user }, { name }) {
    if (!serverToolsFor(user.waId)) return fail(NO_SERVER_ACCESS);
    const removed = await removeUserServer(user, name);
    if (removed) return ok(`Server ${name} diputus dan kunci Milo untuknya dihapus.`);
    const configured = (await summarizeServers(user, DOCKER_CHECKS)).some((s) => s.name === name);
    return fail(configured ? `Server ${name} diatur operator di file konfigurasi, jadi tidak bisa dihapus dari chat.` : `Server "${name}" tidak ada.`);
  },
};

export async function runTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolOutcome> {
  if (!(name in inputs)) return fail(`Tool tidak dikenal: ${name}`);
  const key = name as ToolName;
  const parsed = inputs[key].safeParse(rawInput ?? {});
  if (!parsed.success) {
    return fail(`Input tidak valid untuk ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  try {
    const handler = handlers[key] as (c: ToolContext, i: unknown) => Promise<ToolOutcome>;
    return await handler(ctx, parsed.data);
  } catch (err) {
    return fail(`Gagal menjalankan ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
