export interface SharedContact {
  name: string;
  phones: string[];
  emails: string[];
  organization?: string;
}

export type Inbound =
  | { kind: "text"; text: string }
  | { kind: "button"; id: string; title: string }
  | { kind: "document"; mediaId: string; filename?: string; mime?: string; caption?: string }
  | { kind: "image"; mediaId: string; mime?: string; caption?: string }
  | { kind: "audio"; mediaId: string; mime?: string; voice: boolean }
  | { kind: "video"; mediaId: string; mime?: string; caption?: string }
  | { kind: "contacts"; contacts: SharedContact[] }
  | { kind: "location"; latitude: number; longitude: number; name?: string; address?: string }
  | { kind: "unsupported"; type: string };

export interface InboundMessage {
  wamid: string;
  from: string;
  profileName?: string;
  timestamp: Date;
  inbound: Inbound;
}

export interface StatusUpdate {
  wamid: string;
  recipient: string;
  status: string;
  errors: { code: number; title?: string }[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function parseMessage(m: Obj): Inbound {
  const type = str(m.type) ?? "unknown";
  const part = isObj(m[type]) ? (m[type] as Obj) : {};
  switch (type) {
    case "text":
      return { kind: "text", text: str(part.body) ?? "" };
    case "interactive": {
      const reply = isObj(part.button_reply) ? part.button_reply : isObj(part.list_reply) ? part.list_reply : undefined;
      if (reply) return { kind: "button", id: str(reply.id) ?? "", title: str(reply.title) ?? "" };
      return { kind: "unsupported", type: `interactive:${str(part.type) ?? "?"}` };
    }
    case "button":
      return { kind: "button", id: str(part.payload) ?? "", title: str(part.text) ?? "" };
    case "document":
      return {
        kind: "document",
        mediaId: str(part.id) ?? "",
        filename: str(part.filename),
        mime: str(part.mime_type),
        caption: str(part.caption),
      };
    case "image":
      return { kind: "image", mediaId: str(part.id) ?? "", mime: str(part.mime_type), caption: str(part.caption) };
    case "audio":
      return { kind: "audio", mediaId: str(part.id) ?? "", mime: str(part.mime_type), voice: part.voice === true };
    case "video":
      return { kind: "video", mediaId: str(part.id) ?? "", mime: str(part.mime_type), caption: str(part.caption) };
    case "contacts":
      return {
        kind: "contacts",
        contacts: arr(m.contacts).filter(isObj).map((c) => {
          const name = isObj(c.name) ? c.name : {};
          const org = isObj(c.org) ? c.org : {};
          return {
            name: str(name.formatted_name) ?? str(name.first_name) ?? "Tanpa nama",
            phones: arr(c.phones)
              .filter(isObj)
              .map((p) => str(p.wa_id) ?? str(p.phone) ?? "")
              .filter(Boolean),
            emails: arr(c.emails)
              .filter(isObj)
              .map((e) => str(e.email) ?? "")
              .filter(Boolean),
            organization: str(org.company),
          };
        }),
      };
    case "location":
      return {
        kind: "location",
        latitude: num(part.latitude) ?? 0,
        longitude: num(part.longitude) ?? 0,
        name: str(part.name),
        address: str(part.address),
      };
    default:
      return { kind: "unsupported", type };
  }
}

export function parseWebhook(body: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  if (!isObj(body)) return { messages, statuses };

  for (const entry of arr(body.entry).filter(isObj)) {
    for (const change of arr(entry.changes).filter(isObj)) {
      const value = isObj(change.value) ? change.value : {};
      const profiles = new Map<string, string>();
      for (const c of arr(value.contacts).filter(isObj)) {
        const waId = str(c.wa_id);
        const profile = isObj(c.profile) ? str(c.profile.name) : undefined;
        if (waId && profile) profiles.set(waId, profile);
      }
      for (const m of arr(value.messages).filter(isObj)) {
        const wamid = str(m.id);
        const from = str(m.from);
        if (!wamid || !from) continue;
        const ts = Number(str(m.timestamp) ?? "0");
        messages.push({
          wamid,
          from,
          profileName: profiles.get(from),
          timestamp: ts > 0 ? new Date(ts * 1000) : new Date(),
          inbound: parseMessage(m),
        });
      }
      for (const s of arr(value.statuses).filter(isObj)) {
        statuses.push({
          wamid: str(s.id) ?? "",
          recipient: str(s.recipient_id) ?? "",
          status: str(s.status) ?? "",
          errors: arr(s.errors)
            .filter(isObj)
            .map((e) => ({ code: num(e.code) ?? 0, title: str(e.title) })),
        });
      }
    }
  }
  return { messages, statuses };
}

export function describeInbound(i: Inbound): string {
  switch (i.kind) {
    case "text":
      return i.text;
    case "button":
      return i.title;
    case "document":
      return i.caption ?? i.filename ?? "[dokumen]";
    case "image":
      return i.caption ?? "[foto]";
    case "audio":
      return i.voice ? "[pesan suara]" : "[audio]";
    case "video":
      return i.caption ?? "[video]";
    case "contacts":
      return `[kontak: ${i.contacts.map((c) => c.name).join(", ")}]`;
    case "location":
      return `[lokasi: ${i.name ?? ""} ${i.latitude},${i.longitude}]`.trim();
    case "unsupported":
      return `[${i.type}]`;
  }
}
