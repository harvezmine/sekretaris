import { callGoogle, ENDPOINTS, SCOPE } from "./client.js";
import { isoInZone } from "../util.js";

/**
 * The user's own to-do list, the one that sits beside Gmail and Calendar on a laptop. Milo writes into it so a task
 * mentioned in chat is there when they open their computer, and reads it so the morning greeting knows about work
 * they typed themselves.
 *
 * Google Tasks keeps a date, never a time: the API drops the time part of "due". Reminders therefore stay Milo's
 * own, with their exact hour, and a task is the lighter thing the user ticks off during the day.
 */

const SCOPES = [SCOPE.tasks];
const LISTS = `${ENDPOINTS.tasks}/users/@me/lists`;
const TASKS = `${ENDPOINTS.tasks}/lists`;
/** Google's own default list, which is what people see when they open Tasks. */
export const DEFAULT_LIST = "@default";

export interface TaskList {
  id: string;
  title: string;
}

export interface Task {
  id: string;
  title: string;
  /** Date only, as Google stores it; the time of day is not kept. */
  due?: string;
  notes?: string;
  status: "needsAction" | "completed";
  listTitle: string;
  link?: string;
}

interface RawTask {
  id: string;
  title?: string;
  due?: string;
  notes?: string;
  status?: string;
  webViewLink?: string;
}

export async function taskLists(userId: string): Promise<TaskList[]> {
  const res = await callGoogle<{ items?: { id: string; title?: string }[] }>(userId, SCOPES, { url: LISTS, query: { maxResults: 20 } });
  return (res.items ?? []).map((l) => ({ id: l.id, title: l.title ?? "Tugas" }));
}

/** A list the user named, matched loosely; without a name, Google's default list. */
async function resolveList(userId: string, name: string | undefined): Promise<TaskList> {
  if (!name?.trim()) return { id: DEFAULT_LIST, title: "My Tasks" };
  const lists = await taskLists(userId);
  const wanted = name.trim().toLowerCase();
  const hit = lists.find((l) => l.title.toLowerCase() === wanted) ?? lists.find((l) => l.title.toLowerCase().includes(wanted));
  return hit ?? { id: DEFAULT_LIST, title: "My Tasks" };
}

function shape(raw: RawTask, listTitle: string): Task {
  return {
    id: raw.id,
    title: raw.title?.trim() || "(tanpa judul)",
    ...(raw.due ? { due: raw.due.slice(0, 10) } : {}),
    ...(raw.notes ? { notes: raw.notes.slice(0, 500) } : {}),
    status: raw.status === "completed" ? "completed" : "needsAction",
    listTitle,
    ...(raw.webViewLink ? { link: raw.webViewLink } : {}),
  };
}

/**
 * Due dates are sent as UTC midnight of the day the user meant. Anything else is shifted a day by Google for
 * users east of UTC, which is everyone here.
 */
function dueDate(day: string): string {
  return `${day.slice(0, 10)}T00:00:00.000Z`;
}

export async function addTask(
  userId: string,
  input: { title: string; due?: string; notes?: string; list?: string },
): Promise<Task> {
  const list = await resolveList(userId, input.list);
  const created = await callGoogle<RawTask>(userId, SCOPES, {
    method: "POST",
    url: `${TASKS}/${encodeURIComponent(list.id)}/tasks`,
    json: {
      title: input.title.trim().slice(0, 500),
      ...(input.due ? { due: dueDate(input.due) } : {}),
      ...(input.notes ? { notes: input.notes.slice(0, 2000) } : {}),
    },
  });
  return shape(created, list.title);
}

export interface TaskQuery {
  /** Only tasks due on or before this day, in the user's zone. Tasks with no date are left out when set. */
  dueBefore?: string;
  list?: string;
  max?: number;
}

/** Open tasks, the soonest first, with undated ones last so a due date is what stands out. */
export async function openTasks(userId: string, query: TaskQuery = {}): Promise<Task[]> {
  const lists = query.list ? [await resolveList(userId, query.list)] : await taskLists(userId);
  const max = Math.min(Math.max(query.max ?? 20, 1), 50);
  const found: Task[] = [];
  for (const list of lists.slice(0, 5)) {
    const res = await callGoogle<{ items?: RawTask[] }>(userId, SCOPES, {
      url: `${TASKS}/${encodeURIComponent(list.id)}/tasks`,
      query: {
        showCompleted: false,
        showHidden: false,
        maxResults: max,
        ...(query.dueBefore ? { dueMax: dueDate(query.dueBefore) } : {}),
      },
    });
    for (const raw of res.items ?? []) found.push(shape(raw, list.title));
  }
  return found
    .filter((t) => t.status === "needsAction" && (!query.dueBefore || t.due))
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title))
    .slice(0, max);
}

/** Tasks due today or already overdue, for the agenda and the morning greeting. */
export async function tasksDueToday(userId: string, timeZone: string, now = new Date()): Promise<Task[]> {
  return openTasks(userId, { dueBefore: isoInZone(now, timeZone).slice(0, 10), max: 10 });
}

export class TaskNotFoundError extends Error {
  constructor(readonly title: string) {
    super(`Tidak ada tugas yang cocok dengan "${title}".`);
    this.name = "TaskNotFoundError";
  }
}

/** Ticking one off: the user says roughly what it was, so the closest open task by name wins. */
export async function completeTask(userId: string, title: string): Promise<Task> {
  const open = await openTasks(userId, { max: 50 });
  const wanted = title.trim().toLowerCase();
  const hit =
    open.find((t) => t.title.toLowerCase() === wanted) ??
    open.find((t) => t.title.toLowerCase().includes(wanted)) ??
    open.find((t) => wanted.includes(t.title.toLowerCase()));
  if (!hit) throw new TaskNotFoundError(title);
  const list = await resolveList(userId, hit.listTitle === "My Tasks" ? undefined : hit.listTitle);
  const done = await callGoogle<RawTask>(userId, SCOPES, {
    method: "PATCH",
    url: `${TASKS}/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(hit.id)}`,
    json: { status: "completed" },
  });
  return shape(done, hit.listTitle);
}
