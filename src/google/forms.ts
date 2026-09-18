import { sql } from "../db/index.js";
import { callGoogle, ENDPOINTS, GoogleApiError, SCOPE } from "./client.js";

/**
 * A form the user can send to a group and collect answers from: pesanan, absensi, RSVP, survei.
 *
 * Two things are easy to get wrong and would waste the user's time, so both are done here. A form made through the
 * API is private until it is published, and a link that opens "akses ditolak" is worse than no form at all. And the
 * Forms API has no way to list forms, so which form is "form kue lebaran" is remembered here rather than guessed.
 */

export const FORM_MIME = "application/vnd.google-apps.form";
const WRITE = [SCOPE.formsBody];
const READ_RESPONSES = [SCOPE.formsResponses];
const DRIVE = [SCOPE.driveFile];
const FORMS = `${ENDPOINTS.forms}/forms`;
/** Enough to answer "sudah berapa yang isi", without pulling a year of answers into a WhatsApp reply. */
const MAX_RESPONSES = 100;
const SAMPLE = 5;

export type QuestionType = "text" | "paragraph" | "choice" | "checkbox" | "date";

export interface Question {
  title: string;
  type: QuestionType;
  options?: string[];
  required?: boolean;
}

export interface FormRef {
  id: string;
  title: string;
  /** The link to send out; anyone holding it can answer. */
  responderUri: string;
  /** The link to open the form itself, for editing. */
  editUri: string;
  public: boolean;
}

export class FormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormError";
  }
}

function questionItem(q: Question): Record<string, unknown> {
  const required = Boolean(q.required);
  switch (q.type) {
    case "paragraph":
      return { required, textQuestion: { paragraph: true } };
    case "date":
      return { required, dateQuestion: { includeTime: false, includeYear: true } };
    case "choice":
    case "checkbox": {
      const options = (q.options ?? []).map((o) => ({ value: o.trim().slice(0, 200) })).filter((o) => o.value);
      if (options.length < 2) throw new FormError(`Pertanyaan "${q.title}" perlu minimal dua pilihan.`);
      return { required, choiceQuestion: { type: q.type === "choice" ? "RADIO" : "CHECKBOX", options, shuffle: false } };
    }
    default:
      return { required, textQuestion: { paragraph: false } };
  }
}

/**
 * Published, then shared. setPublishSettings is the newer way and is not on every deployment of the API, so a
 * refusal there is not fatal; the Drive permission is what actually lets a stranger open the link.
 */
async function openToAnyone(userId: string, formId: string): Promise<boolean> {
  try {
    await callGoogle(userId, WRITE, {
      method: "POST",
      url: `${FORMS}/${encodeURIComponent(formId)}:setPublishSettings`,
      json: { publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } } },
    });
  } catch (err) {
    if (!(err instanceof GoogleApiError) || err.status >= 500) throw err;
  }
  try {
    await callGoogle(userId, DRIVE, {
      method: "POST",
      url: `${ENDPOINTS.drive}/files/${encodeURIComponent(formId)}/permissions`,
      query: { supportsAllDrives: true },
      json: { role: "reader", type: "anyone", view: "published" },
    });
    return true;
  } catch (err) {
    if (err instanceof GoogleApiError) return false;
    throw err;
  }
}

async function remember(userId: string, form: FormRef): Promise<void> {
  await sql`
    insert into google_forms (user_id, form_id, title, responder_uri)
    values (${userId}, ${form.id}, ${form.title}, ${form.responderUri})
    on conflict (user_id, form_id) do update set title = excluded.title, responder_uri = excluded.responder_uri
  `;
}

export async function createForm(
  userId: string,
  input: { title: string; description?: string; questions: Question[] },
): Promise<FormRef> {
  if (!input.questions.length) throw new FormError("Sebutkan minimal satu pertanyaan.");
  const title = input.title.trim().slice(0, 300);
  const created = await callGoogle<{ formId: string; responderUri?: string }>(userId, WRITE, {
    method: "POST",
    url: FORMS,
    json: { info: { title, documentTitle: title } },
  });

  const requests: unknown[] = [];
  if (input.description?.trim()) {
    requests.push({
      updateFormInfo: { info: { description: input.description.trim().slice(0, 2000) }, updateMask: "description" },
    });
  }
  input.questions.slice(0, 20).forEach((q, index) => {
    requests.push({
      createItem: { item: { title: q.title.trim().slice(0, 300), questionItem: { question: questionItem(q) } }, location: { index } },
    });
  });
  await callGoogle(userId, WRITE, {
    method: "POST",
    url: `${FORMS}/${encodeURIComponent(created.formId)}:batchUpdate`,
    json: { requests, includeFormInResponse: false },
  });

  const shared = await openToAnyone(userId, created.formId);
  const form: FormRef = {
    id: created.formId,
    title,
    responderUri: created.responderUri ?? `https://docs.google.com/forms/d/e/${created.formId}/viewform`,
    editUri: `https://docs.google.com/forms/d/${created.formId}/edit`,
    public: shared,
  };
  await remember(userId, form);
  return form;
}

export interface StoredForm {
  formId: string;
  title: string;
  responderUri: string;
  createdAt: Date;
}

export async function listForms(userId: string, max = 10): Promise<StoredForm[]> {
  return sql<StoredForm[]>`
    select form_id, title, responder_uri, created_at from google_forms
    where user_id = ${userId} order by id desc limit ${Math.min(Math.max(max, 1), 20)}
  `;
}

async function findForm(userId: string, name: string): Promise<StoredForm | undefined> {
  const wanted = name.trim().toLowerCase();
  const forms = await listForms(userId, 20);
  return (
    forms.find((f) => f.title.toLowerCase() === wanted) ??
    forms.find((f) => f.title.toLowerCase().includes(wanted)) ??
    forms.find((f) => wanted.includes(f.title.toLowerCase()))
  );
}

interface RawAnswer {
  textAnswers?: { answers?: { value?: string }[] };
}

interface RawResponse {
  createTime?: string;
  answers?: Record<string, RawAnswer>;
}

interface RawForm {
  items?: {
    title?: string;
    questionItem?: { question?: { questionId?: string; choiceQuestion?: { type?: string } } };
  }[];
}

export interface AnswerSummary {
  question: string;
  /** Counted per option for a choice, or the latest few answers for anything written by hand. */
  counts?: Record<string, number>;
  latest?: string[];
  answered: number;
}

export interface FormResponses {
  form: StoredForm;
  total: number;
  lastAt?: string;
  questions: AnswerSummary[];
}

/** Answers, joined back to the questions they belong to, and summarised small enough to read on a phone. */
export async function readResponses(userId: string, name: string): Promise<FormResponses | undefined> {
  const stored = await findForm(userId, name);
  if (!stored) return undefined;

  const [body, answered] = await Promise.all([
    callGoogle<RawForm>(userId, WRITE, { url: `${FORMS}/${encodeURIComponent(stored.formId)}` }),
    callGoogle<{ responses?: RawResponse[] }>(userId, READ_RESPONSES, {
      url: `${FORMS}/${encodeURIComponent(stored.formId)}/responses`,
      query: { pageSize: MAX_RESPONSES },
    }),
  ]);

  const responses = answered.responses ?? [];
  const questions = (body.items ?? [])
    .filter((item) => item.questionItem?.question?.questionId)
    .map((item) => {
      const id = item.questionItem!.question!.questionId!;
      const choice = Boolean(item.questionItem!.question!.choiceQuestion);
      const values = responses.flatMap((r) => r.answers?.[id]?.textAnswers?.answers?.map((a) => a.value ?? "") ?? []).filter(Boolean);
      const summary: AnswerSummary = { question: item.title?.trim() || "(tanpa judul)", answered: values.length };
      if (choice) {
        const counts: Record<string, number> = {};
        for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
        summary.counts = counts;
      } else {
        summary.latest = values.slice(-SAMPLE).reverse();
      }
      return summary;
    });

  const times = responses.map((r) => r.createTime).filter((t): t is string => Boolean(t));
  return {
    form: stored,
    total: responses.length,
    ...(times.length ? { lastAt: times.sort().at(-1)! } : {}),
    questions,
  };
}
