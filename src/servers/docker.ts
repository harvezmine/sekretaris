import type { DockerServer } from "./registry.js";

/** Read-only Docker Engine API calls, made through a socket proxy that rejects anything but GET. */

export interface DockerInfo {
  Name: string;
  OperatingSystem: string;
  KernelVersion: string;
  ServerVersion: string;
  NCPU: number;
  MemTotal: number;
  Containers: number;
  ContainersRunning: number;
  ContainersStopped: number;
  Images: number;
}

export interface DockerContainer {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
}

interface DockerStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
}

export interface DockerDiskUsage {
  LayersSize?: number;
  Images?: { Size?: number; SharedSize?: number; Containers?: number }[] | null;
  Containers?: { SizeRw?: number }[] | null;
  Volumes?: { Name: string; UsageData?: { Size?: number } | null }[] | null;
  BuildCache?: { Size?: number; InUse?: boolean }[] | null;
}

export class DockerApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DockerApiError";
  }
}

export type Fetch = typeof fetch;

export class DockerReader {
  constructor(
    private readonly server: DockerServer,
    private readonly http: Fetch = fetch,
  ) {}

  private async get(pathAndQuery: string, timeoutMs = 15_000): Promise<Response> {
    let res: Response;
    try {
      res = await this.http(`${this.server.proxyUrl}${pathAndQuery}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new DockerApiError(`Docker API tidak bisa dihubungi: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let message = body.slice(0, 200);
      try {
        message = (JSON.parse(body) as { message?: string }).message ?? message;
      } catch {
        // proxy errors are plain text
      }
      throw new DockerApiError(res.status === 404 ? `Tidak ditemukan: ${message}` : `Docker API ${res.status}: ${message}`, res.status);
    }
    return res;
  }

  async info(): Promise<DockerInfo> {
    return (await (await this.get("/info")).json()) as DockerInfo;
  }

  async containers(): Promise<DockerContainer[]> {
    return (await (await this.get("/containers/json?all=1")).json()) as DockerContainer[];
  }

  async diskUsage(): Promise<DockerDiskUsage> {
    return (await (await this.get("/system/df", 30_000)).json()) as DockerDiskUsage;
  }

  /** CPU % since the previous sample and memory without page cache, matching `docker stats`. */
  async stats(id: string): Promise<{ cpuPercent: number | null; memBytes: number | null; memLimit: number | null }> {
    const s = (await (await this.get(`/containers/${encodeURIComponent(id)}/stats?stream=false`)).json()) as DockerStats;
    const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
    const cpus = s.cpu_stats?.online_cpus ?? 1;
    const cpuPercent = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cpus * 100 : null;
    const usage = s.memory_stats?.usage;
    const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.total_inactive_file ?? 0;
    return {
      cpuPercent,
      memBytes: usage === undefined ? null : Math.max(usage - cache, 0),
      memLimit: s.memory_stats?.limit ?? null,
    };
  }

  async logs(container: string, tail: number): Promise<string> {
    const res = await this.get(
      `/containers/${encodeURIComponent(container)}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`,
    );
    return demuxLogs(Buffer.from(await res.arrayBuffer()));
  }
}

/** Non-TTY containers frame each chunk with an 8-byte header: stream type, three zero bytes, big-endian length. */
export function demuxLogs(buf: Buffer): string {
  const framed = buf.length >= 8 && buf[0]! <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!framed) return buf.toString("utf8");
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    parts.push(buf.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(parts).toString("utf8");
}
