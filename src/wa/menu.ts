import type { Button } from "./client.js";

/**
 * On a channel without tappable buttons, a question stays a question: nobody texting a colleague follows "saya kirim
 * sekarang?" with a numbered list. The wording of the choices belongs in the question itself; only a menu the user
 * asked for spells its entries out, and then as plain lines, not options to pick by number.
 */
export function renderChoices(body: string, rows: Button[]): string {
  const lines = rows.map((r) => `• ${r.title}${r.description ? `: ${r.description}` : ""}`);
  return `${body}\n${lines.join("\n")}`;
}

const YES = /^(ya|iya|iyaa+|yes|yup|yoi|y|ok|oke+|okay|okey|boleh|mau|sip|siap|silakan|silahkan|ayo|gas|bisa|lanjut|lanjutkan|setuju|betul|benar|jadi)\b/i;
const NO = /^(tidak|ga|gak|nggak|enggak|engga|jangan|batal|batalkan|cancel|no|belum|nanti|nanti saja|skip|lewati|gausah|ga usah|gak usah|tidak usah|jgn)\b/i;

/**
 * Turns what someone typed back into the choice they meant: the words of the choice itself, a short phrase inside it
 * ("agenda" for "Agenda hari ini"), or an ordinary yes or no where the question only had those two answers.
 */
export function matchMenuReply(text: string, buttons: Button[]): Button | undefined {
  const t = text.trim();
  const key = comparable(t);
  if (!key) return undefined;
  const bare = stripSuffixes(key);

  const named = buttons.find((b) =>
    [b.title, ...(b.say ?? [])].some((choice) => {
      const c = comparable(choice);
      return c === key || stripSuffixes(c) === bare;
    }),
  );
  if (named) return named;

  // A few words either way around the choice: "harganya" or "lihat harganya dulu" both pick "Lihat Harga". A longer
  // sentence is a message for the model, not a pick from a menu.
  if (bare.split(" ").length <= 4) {
    const near = buttons.filter((b) =>
      [b.title, ...(b.say ?? [])].some((choice) => {
        const c = ` ${stripSuffixes(comparable(choice))} `;
        return c.includes(` ${bare} `) || ` ${bare} `.includes(c);
      }),
    );
    if (near.length === 1) return near[0];
  }

  const yes = buttons.find((b) => b.answer === "yes");
  const no = buttons.find((b) => b.answer === "no");
  if (yes || no) {
    // "kirim aja", "jangan dulu": the answer starts with the choice and trails off the way people talk.
    const opens = [yes, no].find((b) => b && [b.title, ...(b.say ?? [])].some((c) => bare.startsWith(`${stripSuffixes(comparable(c))} `)));
    if (opens) return opens;
    if (yes && YES.test(t)) return yes;
    if (no && NO.test(t)) return no;
    return undefined;
  }
  // Only where nothing can be confirmed by accident: a bare number is never how these are offered any more.
  const digit = /^\(?\s*(\d{1,2})\s*[).]?$/.exec(t);
  return digit ? buttons[Number(digit[1]) - 1] : undefined;
}

/** "Harganya", "kodeku": the possessive endings people add when they answer, dropped only where a real word is left. */
function stripSuffixes(s: string): string {
  return s.replace(/\b(\p{L}{4,}?)(?:nya|ku|mu)\b/gu, "$1");
}

/** Titles may carry emoji and punctuation that nobody types back. */
function comparable(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
