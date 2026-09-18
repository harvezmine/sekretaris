import { callGoogle, ENDPOINTS, SCOPE } from "./client.js";
import { normalizePhone } from "../util.js";

/**
 * The user's own Google contacts, read only. This is how Milo learns who "Pak Andi" is without the user having to
 * type a number or share a contact card: their phone's address book is already in Google.
 */

export interface GoogleContact {
  name: string;
  phone: string | null;
  email: string | null;
  organization: string | null;
}

const READ_MASK = "names,emailAddresses,phoneNumbers,organizations";

interface Person {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string; canonicalForm?: string }[];
  organizations?: { name?: string; title?: string }[];
}

function toContact(person: Person | undefined): GoogleContact | undefined {
  if (!person) return undefined;
  const name = person.names?.[0]?.displayName?.trim();
  const raw = person.phoneNumbers?.[0];
  const phone = normalizePhone(raw?.canonicalForm ?? raw?.value ?? "");
  const email = person.emailAddresses?.[0]?.value?.trim() ?? null;
  const org = person.organizations?.[0];
  if (!name || (!phone && !email)) return undefined;
  return {
    name,
    phone,
    email,
    organization: [org?.name, org?.title].filter(Boolean).join(", ") || null,
  };
}

/**
 * Google's contact search runs against a per-user cache that has to be warmed with an empty query first; a cold
 * cache answers an empty list, so one warmup is sent before the real search.
 */
export async function searchGoogleContacts(userId: string, query: string, max = 5): Promise<GoogleContact[]> {
  const text = query.trim();
  if (!text) return [];
  const search = (q: string) =>
    callGoogle<{ results?: { person?: Person }[] }>(userId, [SCOPE.contacts], {
      url: `${ENDPOINTS.people}/people:searchContacts`,
      query: { query: q, readMask: READ_MASK, pageSize: Math.min(Math.max(max, 1), 30) },
    });

  await search("").catch(() => undefined);
  const found = await search(text);
  const seen = new Set<string>();
  const out: GoogleContact[] = [];
  for (const result of found.results ?? []) {
    const contact = toContact(result.person);
    const key = contact?.phone ?? contact?.email ?? "";
    if (!contact || seen.has(key)) continue;
    seen.add(key);
    out.push(contact);
    if (out.length >= max) break;
  }
  return out;
}
