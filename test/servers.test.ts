import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import ssh2, { type ParsedKey } from "ssh2";
import { runTool, SERVER_TOOL_DEFS, TOOL_DEFS, toolsFor } from "../src/agent/tools.ts";
import { config } from "../src/config.ts";
import { migrate, sql, type UserRow } from "../src/db/index.ts";
import {
  appLogsCommand,
  CheckInputError,
  clip,
  isLogFilePath,
  logCheckFor,
  redact,
  runCheck,
  shQuote,
  sshCommand,
} from "../src/servers/checks.ts";
import { demuxLogs } from "../src/servers/docker.ts";
import { installCommand, isPublicAddress, openSecret, resolvePublicHost, sealSecret } from "../src/servers/keys.ts";
import {
  ABS_PATH,
  findApp,
  findServer,
  isServerAdmin,
  registry,
  resetRegistry,
  serverToolsFor,
  type DockerServer,
  type SshServer,
} from "../src/servers/registry.ts";
import { sshExec, SshError } from "../src/servers/ssh.ts";
import { addUserServer, recordCheckOutcome, resolveServer } from "../src/servers/userServers.ts";

const { Server, utils } = ssh2;
const ADMIN = "6281100000001";
const OTHER = "6281299999999";
const dbEnabled = Boolean(process.env.TEST_DATABASE_URL);
const dir = mkdtempSync(path.join(tmpdir(), "milo-servers-"));
const hostKey = utils.generateKeyPairSync("ed25519");
const clientKey = utils.generateKeyPairSync("ed25519");
const strangerKey = utils.generateKeyPairSync("ed25519");
writeFileSync(path.join(dir, "client"), clientKey.private);
writeFileSync(path.join(dir, "stranger"), strangerKey.private);

const hostFingerprint = (() => {
  const parsed = utils.parseKey(hostKey.public);
  if (parsed instanceof Error) throw parsed;
  return `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
})();

writeFileSync(
  path.join(dir, "servers.json"),
  JSON.stringify({
    servers: [
      {
        name: "vps",
        description: "VPS uji",
        host: "127.0.0.1",
        port: 1,
        user: "milo",
        key: "client",
        apps: [{ name: "toko", description: "toko online", logs: { type: "compose", dir: "/srv/toko", service: "web" } }],
      },
      { name: "rusak", host: "127.0.0.1", user: "milo; rm", key: "client" },
      { name: "pw", host: "127.0.0.1", user: "milo", password_env: "MILO_TEST_SSH_PASSWORD" },
      { name: "tanpa-login", host: "127.0.0.1", user: "milo" },
      {
        name: "jalur-aneh",
        host: "127.0.0.1",
        user: "milo",
        key: "client",
        apps: [{ name: "x", logs: { type: "file", path: "/var/log/../../etc/shadow" } }],
      },
    ],
  }),
);
process.env.MILO_TEST_SSH_PASSWORD = "rahasia-uji";
Object.assign(config, {
  SERVER_ACCESS: "admin",
  SERVER_ADMIN_NUMBERS: `+${ADMIN}, 0812-0000`,
  DOCKER_PROXY_URL: "http://dockerproxy.test:2375/",
  SERVERS_FILE: path.join(dir, "servers.json"),
});
resetRegistry();

const fakeUser = (waId: string) => ({ id: "1", waId, timezone: "Asia/Jakarta" }) as unknown as UserRow;

describe("server registry and access", () => {
  test("a malformed server entry is skipped and reported without dropping the others", () => {
    assert.equal(findServer("server-milo")?.kind, "docker");
    assert.equal((findServer("server-milo") as DockerServer).proxyUrl, "http://dockerproxy.test:2375");
    const vps = findServer("vps") as SshServer;
    assert.equal(vps.kind, "ssh");
    assert.equal(vps.keyPath, path.join(dir, "client"));
    assert.equal(findServer("rusak"), undefined);
    const pw = findServer("pw") as SshServer;
    assert.equal(pw.password, "rahasia-uji");
    assert.equal(pw.keyPath, undefined);
    assert.equal(findServer("tanpa-login"), undefined);
    assert.equal(findServer("jalur-aneh"), undefined);
    const problems = registry().problems.join("\n");
    assert.match(problems, /server "rusak" diabaikan: user/);
    assert.match(problems, /server "tanpa-login" diabaikan: isi "key" atau "password_env"/);
    assert.match(problems, /server "jalur-aneh" diabaikan: apps\.0\.logs\.path/);
    const toko = findApp("vps/toko")!;
    assert.deepEqual(logCheckFor(toko.app), { check: "compose_logs", target: "/srv/toko", service: "web" });
  });

  test("server tools follow SERVER_ACCESS and are identical for everyone who has them", async () => {
    assert.equal(isServerAdmin(ADMIN), true);
    assert.equal(isServerAdmin(OTHER), false);
    assert.equal(toolsFor(fakeUser(OTHER)), TOOL_DEFS);
    const names = toolsFor(fakeUser(ADMIN)).map((t) => t.name);
    for (const t of SERVER_TOOL_DEFS) assert.ok(names.includes(t.name), t.name);
    assert.deepEqual(names, [...names].sort());
    const denied = await runTool({ user: fakeUser(OTHER) }, "server_check", { server: "server-milo", check: "overview" });
    assert.equal(denied.isError, true);
    const badCheck = await runTool({ user: fakeUser(ADMIN) }, "server_check", { server: "server-milo", check: "reboot" });
    assert.equal(badCheck.isError, true);

    try {
      config.SERVER_ACCESS = "all";
      assert.equal(serverToolsFor(OTHER), true);
      assert.equal(toolsFor(fakeUser(OTHER)), toolsFor(fakeUser(ADMIN)));
      config.SERVER_ACCESS = "off";
      assert.equal(toolsFor(fakeUser(ADMIN)), TOOL_DEFS);
    } finally {
      config.SERVER_ACCESS = "admin";
    }
    for (const t of SERVER_TOOL_DEFS) {
      assert.ok(!JSON.stringify(t).includes("server-milo"), "no per-user data in shared tool definitions");
    }
  });

  test("user servers must resolve to public addresses", async () => {
    for (const ip of ["10.1.2.3", "172.18.0.5", "192.168.1.10", "127.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ["82.25.62.151", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      assert.equal(isPublicAddress(ip), true, ip);
    }
    const resolve = async (host: string) => (host === "internal.example.com" ? ["8.8.8.8", "10.0.0.9"] : ["93.184.216.34"]);
    assert.equal(await resolvePublicHost("toko.example.com", { resolve }), "93.184.216.34");
    await assert.rejects(resolvePublicHost("internal.example.com", { resolve }), /alamat privat/);
    await assert.rejects(resolvePublicHost("db", { resolve }), /bukan alamat server yang valid/);
    await assert.rejects(resolvePublicHost("dockerproxy", { resolve }), /bukan alamat server yang valid/);
    await assert.rejects(resolvePublicHost("a b.com", { resolve }), /bukan alamat server yang valid/);
    assert.equal(await resolvePublicHost("[2606:4700::1111]"), "2606:4700::1111");
  });

  test("private keys are sealed with the configured secret", () => {
    const sealed = sealSecret("-----BEGIN OPENSSH PRIVATE KEY-----\nabc");
    assert.ok(!sealed.includes("OPENSSH"));
    assert.equal(openSecret(sealed), "-----BEGIN OPENSSH PRIVATE KEY-----\nabc");
    const original = config.SERVER_KEY_SECRET;
    try {
      config.SERVER_KEY_SECRET = "another-secret-another-secret-another";
      assert.throws(() => openSecret(sealed), /SERVER_KEY_SECRET mungkin berubah/);
      config.SERVER_KEY_SECRET = "";
      assert.throws(() => sealSecret("x"), /belum dikonfigurasi/);
    } finally {
      config.SERVER_KEY_SECRET = original;
    }
    assert.equal(
      installCommand("ssh-ed25519 AAAAC3 milo-1-toko"),
      "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo 'restrict ssh-ed25519 AAAAC3 milo-1-toko' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
    );
  });
});

describe("ssh commands", () => {
  test("targets that could escape the command are rejected", () => {
    for (const target of ["nginx; reboot", "-h", "$(id)", "a b", "`id`", "nginx\nreboot"]) {
      for (const check of ["service_logs", "container_logs", "pm2_logs", "service_status"] as const) {
        assert.throws(() => sshCommand({ check, target }), CheckInputError, `${check} ${target}`);
      }
    }
    assert.throws(() => sshCommand({ check: "compose_logs", target: "/srv/toko", service: "web; id" }), CheckInputError);
    assert.throws(() => sshCommand({ check: "compose_logs", target: "srv/toko" }), CheckInputError);
    assert.throws(() => sshCommand({ check: "container_logs" }), CheckInputError);
    assert.throws(() => sshCommand({ check: "http", url: "file:///etc/passwd" }), CheckInputError);
    assert.throws(() => sshCommand({ check: "http", url: "https://u:p@example.com" }), CheckInputError);
  });

  test("file_logs reads log files only", () => {
    for (const bad of ["/etc/shadow", "/home/sigma/app/.env", "/srv/toko/config.json", "/var/log/../etc/shadow", "/srv/app.log/../../etc/passwd"]) {
      assert.equal(isLogFilePath(bad), false, bad);
      assert.throws(() => sshCommand({ check: "file_logs", target: bad }), CheckInputError, bad);
    }
    for (const good of ["/var/log/nginx/error.log", "/var/log/syslog", "/srv/toko/storage/logs/laravel.log", "/home/sigma/app/out.err", "/srv/app/app.log.1"]) {
      assert.equal(isLogFilePath(good), true, good);
    }
  });

  test("log file paths must be absolute and cannot climb out", () => {
    for (const bad of ["/../etc/shadow", "/var/log/../../etc/shadow", "/var/log/..", "relative/app.log", "/var/log/app log", "/var/log/$(id)"]) {
      assert.equal(ABS_PATH.test(bad), false, bad);
    }
    for (const good of ["/var/log/toko/error.log", "/srv/toko", "/home/sigma/app/..hidden/log", "/"]) {
      assert.equal(ABS_PATH.test(good), true, good);
    }
  });

  test("each log check reads with a fixed, quoted command", () => {
    assert.equal(
      sshCommand({ check: "compose_logs", target: "/srv/toko", service: "web", lines: 50 }),
      "export LC_ALL=C; { cd '/srv/toko' && docker compose logs --no-color --timestamps --tail 50 'web'; } 2>&1 | tail -n 50",
    );
    assert.equal(
      sshCommand({ check: "file_logs", target: "/var/log/toko/error.log", onlyErrors: true }),
      "export LC_ALL=C; { tail -n 1600 '/var/log/toko/error.log'; } 2>&1 | grep -iE 'error|exception|fatal|panic|traceback|critical|failed|unhandled|segfault|killed' | tail -n 80",
    );
    assert.match(sshCommand({ check: "container_logs", target: "toko-web", lines: 500, onlyErrors: true }), /docker logs --tail 5000 --timestamps 'toko-web'.* \| tail -n 300$/);
    assert.match(sshCommand({ check: "service_logs", target: "toko.service", lines: 5 }), /journalctl -u 'toko\.service' -n 10 /);
    assert.match(sshCommand({ check: "pm2_logs", target: "toko", lines: 20 }), /pm2 logs 'toko' --lines 20 --nostream --raw/);
    assert.equal(appLogsCommand({ type: "docker", container: "x" }, 10, false), sshCommand({ check: "container_logs", target: "x", lines: 10 }));
    const http = sshCommand({ check: "http", url: "https://example.com/a?b='c'" });
    assert.ok(http.includes(shQuote("https://example.com/a?b=%27c%27")), http);
    assert.equal(shQuote("it's"), `'it'\\''s'`);
  });

  test("secrets are masked and long output is clipped from the right end", () => {
    const masked = redact(
      [
        "DATABASE_URL=postgres://milo:hunter2@db:5432/milo",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        '{"api_key": "sk_live_0123456789abcdef"}',
        "INSTANPAY key sk_test_abcdefgh12345 dipakai",
        "db password = s3cret!",
        "request selesai dalam 20ms",
      ].join("\n"),
    );
    for (const secret of ["hunter2", "abcdefghijklmnop", "0123456789abcdef", "abcdefgh12345", "s3cret"]) {
      assert.ok(!masked.includes(secret), `${secret} bocor:\n${masked}`);
    }
    assert.ok(masked.includes("request selesai dalam 20ms"));
    assert.match(clip("a".repeat(50) + "AKHIR", true, 10), /aaaaaAKHIR$/);
    assert.match(clip("AWAL" + "a".repeat(50), false, 10), /^AWALaaaaaa\n/);
  });
});

describe("docker checks", () => {
  const server = { kind: "docker", name: "server-milo", description: "", proxyUrl: "http://proxy" } satisfies DockerServer;
  const frame = (stream: number, text: string) => {
    const body = Buffer.from(text);
    const head = Buffer.alloc(8);
    head[0] = stream;
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const requests: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/info")) {
      return json({ Name: "rumah", OperatingSystem: "Ubuntu 24.04", KernelVersion: "6.8", ServerVersion: "27.0", NCPU: 4, MemTotal: 8 * 1024 ** 3, Containers: 3, ContainersRunning: 2, ContainersStopped: 1, Images: 5 });
    }
    if (url.includes("/containers/json")) {
      return json([
        { Id: "a1", Names: ["/milo-app-1"], Image: "milo-ai", State: "running", Status: "Up 2 hours (healthy)" },
        { Id: "b2", Names: ["/milo-db-1"], Image: "postgres", State: "running", Status: "Up 2 hours (unhealthy)" },
        { Id: "c3", Names: ["/lama"], Image: "nginx", State: "exited", Status: "Exited (1) 3 days ago" },
        { Id: "d4", Names: ["/migrasi"], Image: "milo-ai", State: "exited", Status: "Exited (0) 2 days ago" },
      ]);
    }
    if (url.includes("/stats")) {
      return json({
        cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
        memory_stats: { usage: 300 * 1024 ** 2, limit: 8 * 1024 ** 3, stats: { inactive_file: 100 * 1024 ** 2 } },
      });
    }
    if (url.includes("/logs")) {
      if (url.includes("/containers/hilang/")) return new Response(JSON.stringify({ message: "No such container: hilang" }), { status: 404 });
      return new Response(
        Buffer.concat([frame(1, "server jalan\n"), frame(2, "token=rahasia123\n"), frame(2, "Error: koneksi db putus\n")]),
      );
    }
    return new Response("forbidden", { status: 403 });
  }) as typeof fetch;

  test("overview flags containers that are down or unhealthy", async () => {
    const out = await runCheck(server, { check: "overview" }, fakeFetch);
    assert.match(out, /^\[server-milo \(Docker\) · overview\]/);
    assert.match(out, /Ubuntu 24\.04/);
    assert.match(out, /2 jalan, 1 berhenti/);
    assert.match(out, /Perlu perhatian:\n- milo-db-1: Up 2 hours \(unhealthy\)\n- lama: Exited \(1\) 3 days ago\nBerhenti dengan normal \(kode 0, biasanya sengaja\): migrasi$/);
  });

  test("containers include CPU and memory like docker stats", async () => {
    const out = await runCheck(server, { check: "containers" }, fakeFetch);
    assert.match(out, /milo-app-1: Up 2 hours \(healthy\) \(milo-ai\) · CPU 80\.0% · RAM 200 MB/);
    assert.match(out, /lama: Exited \(1\) 3 days ago \(nginx\)\n- migrasi: Exited \(0\) 2 days ago \(milo-ai\)$/);
  });

  test("logs are demultiplexed, masked, filterable and addressed by container name", async () => {
    const out = await runCheck(server, { check: "container_logs", target: "milo-app-1", lines: 20 }, fakeFetch);
    assert.match(out, /server jalan\ntoken=\[disamarkan\]\nError: koneksi db putus/);
    assert.ok(requests.some((u) => u.endsWith("/containers/milo-app-1/logs?stdout=1&stderr=1&timestamps=1&tail=20")));
    const errors = await runCheck(server, { check: "container_logs", target: "milo-app-1", lines: 20, onlyErrors: true }, fakeFetch);
    assert.equal(errors, "[server-milo (Docker) · container_logs milo-app-1 error saja]\nError: koneksi db putus");
    assert.ok(requests.some((u) => u.endsWith("tail=400")));
    await assert.rejects(runCheck(server, { check: "container_logs", target: "hilang" }, fakeFetch), /Tidak ditemukan: No such container/);
    assert.equal(demuxLogs(Buffer.from("tty biasa\n")), "tty biasa\n");
  });

  test("host-only checks explain what the Docker target supports", async () => {
    await assert.rejects(runCheck(server, { check: "service_logs", target: "nginx" }, fakeFetch), /Yang tersedia: overview, disk/);
  });
});

describe("ssh execution", () => {
  const commands: string[] = [];
  const allowedKeys: ParsedKey[] = [];
  let sshd: InstanceType<typeof Server>;
  let port = 0;
  const target = (overrides: Partial<SshServer> = {}): SshServer => ({
    kind: "ssh",
    name: "vps",
    description: "",
    host: "127.0.0.1",
    port,
    user: "milo",
    keyPath: path.join(dir, "client"),
    apps: [],
    ...overrides,
  });

  const allowKey = (publicKey: string) => {
    const parsed = utils.parseKey(publicKey);
    if (parsed instanceof Error) throw parsed;
    allowedKeys.push(parsed);
  };

  before(async () => {
    allowKey(clientKey.public);
    sshd = new Server({ hostKeys: [hostKey.private] }, (client) => {
      client.on("error", () => {});
      client.on("authentication", (ctx) => {
        if (ctx.username !== "milo") return ctx.reject(["publickey", "password"]);
        if (ctx.method === "password") return ctx.password === "rahasia-uji" ? ctx.accept() : ctx.reject(["publickey", "password"]);
        if (ctx.method !== "publickey") return ctx.reject(["publickey", "password"]);
        const key = allowedKeys.find((k) => ctx.key.algo === k.type && ctx.key.data.equals(k.getPublicSSH()));
        if (!key) return ctx.reject(["publickey"]);
        if (!ctx.signature) return ctx.accept();
        return key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject(["publickey"]);
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          accept().once("exec", (acceptExec, _reject, info) => {
            commands.push(info.command);
            const stream = acceptExec();
            stream.write(`jalan: ${info.command.length} karakter\n`);
            stream.stderr.write("peringatan kecil\n");
            stream.exit(3);
            stream.end();
          });
        });
      });
    });
    await new Promise<void>((resolve) => sshd.listen(0, "127.0.0.1", resolve));
    port = (sshd.address() as AddressInfo).port;
  });

  after(() => new Promise<void>((resolve) => sshd.close(() => resolve())));

  test("first connection trusts and remembers the host key, then runs the allow-listed command", async () => {
    const out = await runCheck(target(), { check: "service_status", target: "nginx" });
    assert.match(out, /^\[vps \(milo@127\.0\.0\.1\) · service_status nginx\]\njalan: \d+ karakter\nperingatan kecil\n\(kode keluar 3\)$/);
    assert.equal(commands.at(-1), sshCommand({ check: "service_status", target: "nginx" }));
    const known = JSON.parse(readFileSync(path.join(config.DATA_DIR, "known_hosts.json"), "utf8")) as Record<string, string>;
    assert.equal(known[`127.0.0.1:${port}`], hostFingerprint);
  });

  test("a changed host key is refused before any command runs", async () => {
    const before = commands.length;
    writeFileSync(
      path.join(config.DATA_DIR, "known_hosts.json"),
      JSON.stringify({ [`127.0.0.1:${port}`]: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
    );
    await assert.rejects(sshExec(target(), "uptime"), (err: Error) => err instanceof SshError && /berubah/.test(err.message));
    await assert.rejects(sshExec(target({ hostKey: "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }), "uptime"), /berubah/);
    assert.equal(commands.length, before);
    const pinned = await sshExec(target({ hostKey: hostFingerprint }), "uptime");
    assert.equal(pinned.code, 3);
  });

  test("password login works without a key, and a wrong password is explained", async () => {
    const res = await sshExec(target({ hostKey: hostFingerprint, keyPath: undefined, password: "rahasia-uji" }), "uptime");
    assert.equal(res.code, 3);
    await assert.rejects(
      sshExec(target({ hostKey: hostFingerprint, keyPath: undefined, password: "salah" }), "uptime"),
      /ditolak\. Periksa password-nya/,
    );
  });

  test("log checks with only_errors run the filtered command", async () => {
    const out = await runCheck(target({ hostKey: hostFingerprint }), { check: "compose_logs", target: "/srv/toko", service: "web", onlyErrors: true });
    assert.match(out, /^\[vps \(milo@127\.0\.0\.1\) · compose_logs \/srv\/toko web error saja\]\n/);
    assert.equal(commands.at(-1), sshCommand({ check: "compose_logs", target: "/srv/toko", service: "web", onlyErrors: true }));
  });

  test("an unknown client key and a missing key file give plain explanations", async () => {
    await assert.rejects(sshExec(target({ hostKey: hostFingerprint, keyPath: path.join(dir, "stranger") }), "uptime"), /ditolak/);
    await assert.rejects(sshExec(target({ keyPath: path.join(dir, "tidak-ada") }), "uptime"), /tidak bisa dibaca \(ENOENT\)/);
  });

  describe("servers added by users", { skip: !dbEnabled && "set TEST_DATABASE_URL to run" }, () => {
    const local = { allow: () => true };
    let owner: UserRow;
    let admin: UserRow;
    let other: UserRow;

    before(async () => {
      await migrate();
      const make = async (waId: string) => {
        await sql`delete from users where wa_id = ${waId}`;
        const [u] = await sql<UserRow[]>`
          insert into users (wa_id, display_name, status, plan, state) values (${waId}, 'Uji', 'trialing', 'trial', 'READY') returning *
        `;
        return u!;
      };
      owner = await make("6281300000001");
      admin = await make(ADMIN);
      other = await make("6281300000002");
    });

    after(async () => {
      await sql`delete from users where id in ${sql([owner.id, admin.id, other.id])}`;
    });

    test("adding a server returns an install command and keeps the key on retry", async () => {
      const first = await addUserServer(owner, { name: "Toko", host: "127.0.0.1", port, user: "milo", description: "toko" }, local);
      assert.equal(first.name, "toko");
      assert.equal(first.reused, false);
      assert.match(first.publicKey, /^ssh-ed25519 \S+ milo-\d+-toko$/);
      assert.ok(first.installCommand.includes(`'restrict ${first.publicKey}'`));
      const [stored] = await sql<{ privateKeyEnc: string }[]>`select private_key_enc from user_servers where user_id = ${owner.id}`;
      assert.ok(!stored!.privateKeyEnc.includes("PRIVATE KEY"), "private key is encrypted at rest");

      const again = await addUserServer(owner, { name: "toko", host: "127.0.0.1", port, user: "milo" }, local);
      assert.equal(again.reused, true);
      assert.equal(again.publicKey, first.publicKey);
    });

    test("private addresses, bad names, the per-user limit and operator names are refused", async () => {
      await assert.rejects(addUserServer(owner, { name: "lan", host: "192.168.1.5", user: "milo" }), /alamat privat/);
      await assert.rejects(addUserServer(owner, { name: "db", host: "127.0.0.1", user: "milo" }), /alamat privat/);
      await assert.rejects(addUserServer(owner, { name: "nama salah", host: "203.0.113.10", user: "milo" }), /Nama server/);
      await assert.rejects(addUserServer(owner, { name: "x", host: "203.0.113.10", user: "root;id" }), /user SSH/);
      await addUserServer(owner, { name: "kedua", host: "203.0.113.10", user: "milo" });
      await assert.rejects(addUserServer(owner, { name: "ketiga", host: "203.0.113.11", user: "milo" }), /Maksimal 2 server/);
      await assert.rejects(addUserServer(admin, { name: "vps", host: "203.0.113.12", user: "milo" }), /konfigurasi/);
    });

    test("the first check pins the host key and marks the server connected", async () => {
      const [row] = await sql<{ publicKey: string }[]>`select public_key from user_servers where user_id = ${owner.id} and name = 'toko'`;
      allowKey(row!.publicKey);
      const resolved = (await resolveServer(owner, "toko", local))!;
      assert.equal((resolved.target as SshServer).displayHost, "127.0.0.1");
      const out = await runCheck(resolved.target, { check: "overview" });
      assert.match(out, /^\[toko \(milo@127\.0\.0\.1\) · overview\]\njalan:/);
      await recordCheckOutcome(resolved.rowId!, null);
      const [stored] = await sql<{ hostKey: string; verifiedAt: Date | null }[]>`
        select host_key, verified_at from user_servers where id = ${resolved.rowId!}
      `;
      assert.equal(stored!.hostKey, hostFingerprint);
      assert.ok(stored!.verifiedAt);
      await assert.rejects(addUserServer(owner, { name: "toko", host: "127.0.0.1", port, user: "milo" }, local), /sudah terhubung/);

      await sql`update user_servers set host_key = 'SHA256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' where id = ${resolved.rowId!}`;
      const changed = (await resolveServer(owner, "toko", local))!;
      await assert.rejects(runCheck(changed.target, { check: "overview" }), /hapus server ini dari Milo lalu tambahkan lagi/);
    });

    test("the tools only reach the caller's own servers, and the default policy re-checks addresses", async () => {
      config.SERVER_ACCESS = "all";
      try {
        const own = await runTool({ user: owner }, "server_check", { server: "toko", check: "overview" });
        assert.match(String(own.content), /alamat privat/, "127.0.0.1 is refused outside tests");
        const notMine = await runTool({ user: other }, "server_check", { server: "toko", check: "overview" });
        assert.match(String(notMine.content), /Server "toko" tidak ada/);
        const operatorOnly = await runTool({ user: other }, "server_check", { server: "server-milo", check: "overview" });
        assert.match(String(operatorOnly.content), /tidak ada/);

        const listed = JSON.parse(String((await runTool({ user: owner }, "server_list", {})).content)) as { name: string; status: string }[];
        assert.deepEqual(
          listed.map((s) => [s.name, s.status]),
          [
            ["kedua", "menunggu kunci Milo dipasang di server"],
            ["toko", "terhubung"],
          ],
        );
        const adminList = JSON.parse(String((await runTool({ user: admin }, "server_list", {})).content)) as { name: string }[];
        assert.deepEqual(
          adminList.map((s) => s.name),
          ["server-milo", "vps", "pw"],
        );

        const added = await runTool({ user: other }, "server_add", { name: "web", host: "203.0.113.20", user: "deploy" });
        assert.match(String(added.content), /install_command/);
        const removed = await runTool({ user: other }, "server_remove", { name: "web" });
        assert.match(String(removed.content), /diputus/);
        const operator = await runTool({ user: admin }, "server_remove", { name: "vps" });
        assert.match(String(operator.content), /diatur operator/);
      } finally {
        config.SERVER_ACCESS = "admin";
      }
    });

    test("deleting a user removes their servers and keys", async () => {
      await sql`delete from users where wa_id = '6281300000009'`;
      const [temp] = await sql<UserRow[]>`insert into users (wa_id) values ('6281300000009') returning *`;
      await addUserServer(temp!, { name: "sementara", host: "203.0.113.30", user: "milo" });
      await sql`delete from users where id = ${temp!.id}`;
      const [left] = await sql<{ n: string }[]>`select count(*) as n from user_servers where user_id = ${temp!.id}`;
      assert.equal(Number(left!.n), 0);
    });
  });
});

after(async () => {
  if (dbEnabled) await sql.end({ timeout: 5 });
});
