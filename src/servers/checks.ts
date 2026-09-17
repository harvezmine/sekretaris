import { readFile, statfs } from "node:fs/promises";
import { config } from "../config.js";
import { DockerReader, type Fetch } from "./docker.js";
import { ABS_PATH, CONTAINER, UNIT, type AppConfig, type DockerServer, type LogSource, type ServerTarget, type SshServer } from "./registry.js";
import { sshExec } from "./ssh.js";

export const CHECKS = [
  "overview",
  "disk",
  "memory",
  "processes",
  "containers",
  "container_logs",
  "compose_logs",
  "services",
  "service_status",
  "service_logs",
  "pm2_logs",
  "file_logs",
  "error_logs",
  "ports",
  "http",
] as const;

export type Check = (typeof CHECKS)[number];

export const DOCKER_CHECKS: readonly Check[] = ["overview", "disk", "memory", "containers", "container_logs", "http"];

const LOG_CHECKS: readonly Check[] = ["container_logs", "compose_logs", "service_logs", "pm2_logs", "file_logs", "error_logs"];

export interface CheckInput {
  check: Check;
  target?: string | undefined;
  service?: string | undefined;
  url?: string | undefined;
  lines?: number | undefined;
  onlyErrors?: boolean | undefined;
}

export class CheckInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckInputError";
  }
}

const MAX_OUTPUT = 8000;

function requireTarget(input: CheckInput, pattern: RegExp, what: string): string {
  const target = input.target?.trim();
  if (!target) throw new CheckInputError(`Cek ${input.check} butuh target (${what}).`);
  if (!pattern.test(target)) throw new CheckInputError(`Target "${target}" bukan nama ${what} yang valid.`);
  return target;
}

function requireUrl(input: CheckInput): string {
  const raw = input.url?.trim() ?? input.target?.trim();
  if (!raw) throw new CheckInputError("Cek http butuh url.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CheckInputError(`"${raw}" bukan URL yang valid.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CheckInputError("Hanya URL http atau https.");
  if (url.username || url.password) throw new CheckInputError("URL tidak boleh memuat nama pengguna atau kata sandi.");
  return url.toString();
}

const lineCount = (lines: number | undefined, fallback = 80) => Math.min(Math.max(Math.trunc(lines ?? fallback), 10), 300);

/** Log files only: anything under /var/log, or a file whose name ends in .log/.out/.err (optionally rotated). */
export function isLogFilePath(path: string): boolean {
  return ABS_PATH.test(path) && (path.startsWith("/var/log/") || /\/[^/]+\.(log|out|err)(\.\d+)?$/.test(path));
}

function logSourceFor(input: CheckInput): LogSource {
  switch (input.check) {
    case "container_logs":
      return { type: "docker", container: requireTarget(input, CONTAINER, "container") };
    case "compose_logs": {
      const dir = requireTarget(input, ABS_PATH, "folder docker compose (path absolut)");
      const service = input.service?.trim();
      if (service && !CONTAINER.test(service)) throw new CheckInputError(`"${service}" bukan nama service yang valid.`);
      return { type: "compose", dir, service: service || undefined };
    }
    case "service_logs":
      return { type: "systemd", unit: requireTarget(input, UNIT, "layanan systemd") };
    case "pm2_logs":
      return { type: "pm2", name: requireTarget(input, CONTAINER, "proses pm2") };
    case "file_logs": {
      const path = requireTarget(input, ABS_PATH, "file log (path absolut)");
      if (!isLogFilePath(path)) {
        throw new CheckInputError("Hanya file log yang bisa dibaca: di bawah /var/log/ atau berakhiran .log, .out, atau .err.");
      }
      return { type: "file", path };
    }
    default:
      throw new CheckInputError(`Cek ${input.check} bukan cek log.`);
  }
}

/** POSIX single-quote: the only character that needs care inside '...' is the quote itself. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const DF = "df -hP -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -hP";

/** Every command a check may run on an SSH server. Nothing here writes, restarts or reads arbitrary files. */
export function sshCommand(input: CheckInput): string {
  const n = lineCount(input.lines);
  if (LOG_CHECKS.includes(input.check) && input.check !== "error_logs") {
    return appLogsCommand(logSourceFor(input), input.lines, input.onlyErrors ?? false);
  }
  const body = ((): string => {
    switch (input.check) {
      case "overview":
        return [
          "echo '== host =='; hostname; uptime",
          "echo; echo '== memori (MB) =='; free -m",
          `echo; echo '== disk =='; ${DF}`,
          "echo; echo '== proses teratas (CPU) =='; ps -eo pid,user,pcpu,pmem,etime,comm --sort=-pcpu | head -n 8",
          "echo; echo '== layanan gagal =='; if command -v systemctl >/dev/null 2>&1; then systemctl --failed --no-legend --plain --no-pager | head -n 20; else echo '(systemctl tidak tersedia)'; fi",
        ].join("; ");
      case "disk":
        return `${DF}; echo; echo '== inode =='; df -iP -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | head -n 20`;
      case "memory":
        return "free -m; echo; echo '== proses teratas (memori) =='; ps -eo pid,user,pmem,rss,comm --sort=-rss | head -n 11";
      case "processes":
        return `uptime; echo; ps -eo pid,user,pcpu,pmem,etime,comm --sort=-pcpu | head -n ${Math.min(n, 40) + 1}`;
      case "containers":
        return [
          "docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}' 2>&1",
          "echo; echo '== pemakaian =='; docker stats --no-stream --format 'table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}' 2>&1",
        ].join("; ");
      case "services":
        return [
          "echo '== gagal =='; systemctl list-units --type=service --state=failed --no-pager --plain --no-legend 2>&1",
          "echo; echo '== berjalan =='; systemctl list-units --type=service --state=running --no-pager --plain --no-legend 2>&1 | head -n 60",
        ].join("; ");
      case "service_status": {
        const unit = shQuote(requireTarget(input, UNIT, "layanan systemd"));
        return `systemctl status --no-pager --lines=0 ${unit} 2>&1; echo; systemctl show -p ActiveState,SubState,NRestarts,ExecMainStartTimestamp ${unit} 2>&1`;
      }
      case "error_logs":
        return `journalctl -p err -n ${n} --no-pager -o short-iso --since '24 hours ago' 2>&1`;
      default:
        throw new CheckInputError(`Cek ${input.check} tidak dikenal.`);
      case "ports":
        return "ss -tlnp 2>/dev/null || ss -tln 2>/dev/null || netstat -tln 2>&1";
      case "http":
        return `curl -sS -o /dev/null -L --max-time 10 -w 'status=%{http_code} waktu=%{time_total}s alamat_akhir=%{url_effective}\\n' ${shQuote(requireUrl(input))} 2>&1`;
    }
  })();
  return `export LC_ALL=C; ${body}`;
}

const ERROR_PATTERN = "error|exception|fatal|panic|traceback|critical|failed|unhandled|segfault|killed";
const ERROR_LINE = new RegExp(ERROR_PATTERN, "i");
const NO_ERROR_LINES = "(tidak ada baris yang terlihat seperti error di log terbaru)";

/**
 * Reads an app's logs from the source the admin configured. With onlyErrors, a window twenty times larger is scanned
 * so that the requested number of error lines can still be found.
 */
export function appLogsCommand(source: LogSource, lines: number | undefined, onlyErrors: boolean): string {
  const n = lineCount(lines);
  const scan = onlyErrors ? Math.min(n * 20, 5000) : n;
  const read = ((): string => {
    switch (source.type) {
      case "docker":
        return `docker logs --tail ${scan} --timestamps ${shQuote(source.container)}`;
      case "compose":
        return `cd ${shQuote(source.dir)} && docker compose logs --no-color --timestamps --tail ${scan}${source.service ? ` ${shQuote(source.service)}` : ""}`;
      case "systemd":
        return `journalctl -u ${shQuote(source.unit)} -n ${scan} --no-pager -o short-iso`;
      case "file":
        return `tail -n ${scan} ${shQuote(source.path)}`;
      case "pm2":
        return `pm2 logs ${shQuote(source.name)} --lines ${scan} --nostream --raw`;
    }
  })();
  const filter = onlyErrors ? ` | grep -iE '${ERROR_PATTERN}'` : "";
  return `export LC_ALL=C; { ${read}; } 2>&1${filter} | tail -n ${n}`;
}

export function describeLogSource(source: LogSource): string {
  switch (source.type) {
    case "docker":
      return `container ${source.container}`;
    case "compose":
      return `docker compose di ${source.dir}${source.service ? ` (service ${source.service})` : ""}`;
    case "systemd":
      return `layanan ${source.unit}`;
    case "file":
      return `file ${source.path}`;
    case "pm2":
      return `pm2 ${source.name}`;
  }
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(authorization|x-api-key)(\s*[:=]\s*)(bearer\s+)?\S+/gi, "$1$2$3[disamarkan]"],
  [/\b([\w.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[\w.-]*"?)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[disamarkan]"],
  [/\bbearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [disamarkan]"],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, "$1_$2_[disamarkan]"],
  [/\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,})/g, "[disamarkan]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1[disamarkan]@"],
];

/** Logs are read by the model and may be quoted back on WhatsApp; strip the common credential shapes first. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), text);
}

/** Logs keep their newest lines; everything else keeps its beginning. */
export function clip(text: string, keepTail: boolean, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  return keepTail
    ? `(… ${text.length - max} karakter awal dipotong)\n${text.slice(-max)}`
    : `${text.slice(0, max)}\n(… ${text.length - max} karakter berikutnya dipotong)`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(0)}%` : "-");

async function hostStats(): Promise<string[]> {
  const lines: string[] = [];
  try {
    const [load, uptime] = await Promise.all([readFile("/proc/loadavg", "utf8"), readFile("/proc/uptime", "utf8")]);
    const days = Number(uptime.split(" ")[0]) / 86_400;
    lines.push(`Beban (1/5/15 mnt): ${load.split(" ").slice(0, 3).join(" / ")} · menyala ${days.toFixed(1)} hari`);
  } catch {
    lines.push("Beban CPU: tidak tersedia di platform ini");
  }
  try {
    const mem = Object.fromEntries(
      (await readFile("/proc/meminfo", "utf8"))
        .split("\n")
        .map((l) => /^(\w+):\s+(\d+)/.exec(l))
        .filter((m): m is RegExpExecArray => Boolean(m))
        .map((m) => [m[1]!, Number(m[2]) * 1024]),
    );
    const total = mem.MemTotal ?? 0;
    const avail = mem.MemAvailable ?? 0;
    lines.push(`Memori: terpakai ${formatBytes(total - avail)} dari ${formatBytes(total)} (${pct(total - avail, total)})`);
    if (mem.SwapTotal) {
      lines.push(`Swap: terpakai ${formatBytes(mem.SwapTotal - (mem.SwapFree ?? 0))} dari ${formatBytes(mem.SwapTotal)}`);
    }
  } catch {
    lines.push("Memori host: tidak tersedia di platform ini");
  }
  try {
    const fs = await statfs(config.DATA_DIR);
    const total = fs.blocks * fs.bsize;
    const free = fs.bavail * fs.bsize;
    lines.push(`Disk Docker: terpakai ${formatBytes(total - free)} dari ${formatBytes(total)} (${pct(total - free, total)}), sisa ${formatBytes(free)}`);
  } catch {
    lines.push("Disk: tidak tersedia");
  }
  return lines;
}

const containerName = (c: { Names: string[]; Id: string }) => c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12);

/** Exit code 0 is a finished job or a deliberate stop; crashes, restart loops and failing health checks are not. */
function needsAttention(c: { State: string; Status: string }): boolean {
  if (/unhealthy/i.test(c.Status)) return true;
  if (c.State === "restarting" || c.State === "dead") return true;
  if (c.State === "exited") return !/^Exited \(0\)/.test(c.Status);
  return false;
}

async function httpCheck(url: string, http: Fetch): Promise<string> {
  const started = Date.now();
  try {
    const res = await http(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel().catch(() => {});
    return `status=${res.status} waktu=${((Date.now() - started) / 1000).toFixed(2)}s alamat_akhir=${res.url || url}`;
  } catch (err) {
    return `gagal setelah ${((Date.now() - started) / 1000).toFixed(2)}s: ${(err as Error).message}`;
  }
}

async function dockerCheck(server: DockerServer, input: CheckInput, http: Fetch): Promise<{ text: string; tail: boolean }> {
  if (!DOCKER_CHECKS.includes(input.check)) {
    throw new CheckInputError(
      `Cek "${input.check}" tidak tersedia untuk ${server.name}, yang dibaca lewat Docker. Yang tersedia: ${DOCKER_CHECKS.join(", ")}.`,
    );
  }
  const docker = new DockerReader(server, http);

  const containerTable = async (withStats: boolean) => {
    const list = await docker.containers();
    const running = list.filter((c) => c.State === "running");
    const stats = withStats
      ? await Promise.all(running.slice(0, 30).map((c) => docker.stats(c.Id).catch(() => null)))
      : [];
    const byId = new Map(running.slice(0, 30).map((c, i) => [c.Id, stats[i] ?? null]));
    return list.map((c) => {
      const s = byId.get(c.Id);
      const usage = s ? ` · CPU ${s.cpuPercent === null ? "-" : `${s.cpuPercent.toFixed(1)}%`} · RAM ${formatBytes(s.memBytes)}` : "";
      return `- ${containerName(c)}: ${c.Status} (${c.Image})${usage}`;
    });
  };

  switch (input.check) {
    case "overview": {
      const [info, host, list] = await Promise.all([docker.info(), hostStats(), docker.containers()]);
      const problems = list.filter(needsAttention);
      const cleanStops = list.filter((c) => c.State === "exited" && !needsAttention(c));
      return {
        tail: false,
        text: [
          `Host: ${info.Name} · ${info.OperatingSystem} · kernel ${info.KernelVersion} · Docker ${info.ServerVersion}`,
          `CPU: ${info.NCPU} core · RAM total ${formatBytes(info.MemTotal)}`,
          ...host,
          `Container: ${info.ContainersRunning} jalan, ${info.ContainersStopped} berhenti, ${info.Containers} total`,
          problems.length ? "Perlu perhatian:" : "Tidak ada container yang crash atau tidak sehat.",
          ...problems.map((c) => `- ${containerName(c)}: ${c.Status}`),
          ...(cleanStops.length
            ? [`Berhenti dengan normal (kode 0, biasanya sengaja): ${cleanStops.map(containerName).join(", ")}`]
            : []),
        ].join("\n"),
      };
    }
    case "disk": {
      const [host, df] = await Promise.all([hostStats(), docker.diskUsage()]);
      const sum = (xs: (number | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
      const volumes = [...(df.Volumes ?? [])].sort((a, b) => (b.UsageData?.Size ?? 0) - (a.UsageData?.Size ?? 0));
      return {
        tail: false,
        text: [
          ...host.filter((l) => l.startsWith("Disk")),
          `Image: ${formatBytes(df.LayersSize)} (${df.Images?.length ?? 0} image)`,
          `Container (lapisan tulis): ${formatBytes(sum((df.Containers ?? []).map((c) => c.SizeRw)))}`,
          `Volume: ${formatBytes(sum(volumes.map((v) => v.UsageData?.Size)))} (${volumes.length} volume)`,
          ...volumes.slice(0, 8).map((v) => `- ${v.Name}: ${formatBytes(v.UsageData?.Size)}`),
          `Build cache: ${formatBytes(sum((df.BuildCache ?? []).map((b) => b.Size)))}`,
        ].join("\n"),
      };
    }
    case "memory":
      return { tail: false, text: [...(await hostStats()).filter((l) => !l.startsWith("Disk")), "Per container:", ...(await containerTable(true))].join("\n") };
    case "containers":
      return { tail: false, text: (await containerTable(true)).join("\n") || "Tidak ada container." };
    case "container_logs": {
      const name = requireTarget(input, CONTAINER, "container");
      const n = lineCount(input.lines);
      if (!input.onlyErrors) return { tail: true, text: (await docker.logs(name, n)).trim() || "(log kosong)" };
      const errors = (await docker.logs(name, Math.min(n * 20, 5000)))
        .split("\n")
        .filter((l) => ERROR_LINE.test(l))
        .slice(-n);
      return { tail: true, text: errors.join("\n") || NO_ERROR_LINES };
    }
    case "http":
      return { tail: false, text: await httpCheck(requireUrl(input), http) };
    default:
      throw new CheckInputError(`Cek "${input.check}" tidak dikenal.`);
  }
}

async function sshCheck(server: SshServer, input: CheckInput): Promise<{ text: string; tail: boolean }> {
  const res = await sshExec(server, sshCommand(input));
  const notes = [
    res.timedOut ? "(dihentikan: melewati batas waktu 20 detik)" : "",
    res.truncated ? "(keluaran terlalu panjang, sebagian dibuang)" : "",
    res.code ? `(kode keluar ${res.code})` : "",
  ].filter(Boolean);
  const tail = LOG_CHECKS.includes(input.check);
  const empty = input.onlyErrors && tail ? NO_ERROR_LINES : "(tidak ada keluaran)";
  return { tail, text: [res.output.trim() || empty, ...notes].join("\n") };
}

export function describeServer(server: ServerTarget): string {
  return server.kind === "docker" ? `${server.name} (Docker)` : `${server.name} (${server.user}@${server.displayHost ?? server.host})`;
}

/** The server_check input that reads a configured app's logs. */
export function logCheckFor(app: AppConfig): Pick<CheckInput, "check" | "target" | "service"> {
  const s = app.logs;
  switch (s.type) {
    case "docker":
      return { check: "container_logs", target: s.container };
    case "compose":
      return { check: "compose_logs", target: s.dir, service: s.service };
    case "systemd":
      return { check: "service_logs", target: s.unit };
    case "file":
      return { check: "file_logs", target: s.path };
    case "pm2":
      return { check: "pm2_logs", target: s.name };
  }
}

export async function runCheck(server: ServerTarget, input: CheckInput, http: Fetch = fetch): Promise<string> {
  const { text, tail } = server.kind === "docker" ? await dockerCheck(server, input, http) : await sshCheck(server, input);
  const detail = [input.target, input.service, input.onlyErrors && LOG_CHECKS.includes(input.check) ? "error saja" : ""]
    .filter(Boolean)
    .join(" ");
  const header = `[${describeServer(server)} · ${input.check}${detail ? ` ${detail}` : ""}]`;
  return `${header}\n${clip(redact(text), tail)}`;
}
