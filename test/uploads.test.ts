import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { config } from "../src/config.ts";
import {
  createUploadToken,
  publicBaseUrl,
  readUploadToken,
  rememberPublicHost,
  resetSeenBaseUrl,
  uploadUrlFor,
} from "../src/uploads/links.ts";
import { isInventedMiloLink, stripInventedLinks } from "../src/agent/linkGuard.ts";
import { uploadPage } from "../src/uploads/page.ts";
import { sniffUpload, stagingPath } from "../src/uploads/routes.ts";

const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));

describe("upload links", () => {
  test("tokens are bound to a user, signed and expiring", () => {
    const now = Date.UTC(2026, 8, 17, 10);
    const token = createUploadToken("21", now);
    assert.deepEqual(readUploadToken(token, now), { userId: "21", expiresAt: new Date(now + 24 * 3600_000) });
    assert.equal(readUploadToken(token, now + 24 * 3600_000 + 1000), undefined, "expired");
    const [id, exp, sig] = token.split(".");
    assert.equal(readUploadToken(`22.${exp}.${sig}`, now), undefined, "other user");
    assert.equal(readUploadToken(`${id}.${(parseInt(exp!, 36) + 3600).toString(36)}.${sig}`, now), undefined, "extended");
    assert.equal(readUploadToken(`${id}.${exp}.${sig!.replace(/.$/, (c) => (c === "a" ? "b" : "a"))}`, now), undefined);
    for (const junk of ["", "21", "21.x", "../../etc", `${token}.x`]) assert.equal(readUploadToken(junk, now), undefined, junk);
  });

  test("the public address comes from config, else from the webhook host", () => {
    resetSeenBaseUrl();
    assert.equal(uploadUrlFor("1"), undefined);
    for (const host of ["localhost", "127.0.0.1", "app", "printer.local", "x.internal", undefined]) rememberPublicHost(host);
    assert.equal(publicBaseUrl(), undefined);
    rememberPublicHost("Ampland-Sublime.trycloudflare.com");
    assert.equal(publicBaseUrl(), "https://ampland-sublime.trycloudflare.com");
    assert.match(uploadUrlFor("1")!, /^https:\/\/ampland-sublime\.trycloudflare\.com\/u\/1\.[0-9a-z]+\.[A-Za-z0-9_-]{32}$/);
    const original = config.PUBLIC_BASE_URL;
    try {
      config.PUBLIC_BASE_URL = "https://milo.example.com/";
      rememberPublicHost("lain.trycloudflare.com");
      assert.equal(publicBaseUrl(), "https://milo.example.com");
    } finally {
      config.PUBLIC_BASE_URL = original;
      resetSeenBaseUrl();
    }
  });

  test("file types are decided from the bytes", () => {
    assert.deepEqual(sniffUpload(bytes("%PDF-1.7\n..."), "apa saja.bin"), { kind: "document", mime: "application/pdf" });
    assert.deepEqual(sniffUpload(bytes([0xff, 0xd8, 0xff, 0xe0, 1]), "foto.pdf"), { kind: "image", mime: "image/jpeg" });
    assert.deepEqual(sniffUpload(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "), "x.webp"), { kind: "image", mime: "image/webp" });
    assert.deepEqual(sniffUpload(bytes("OggS", [0], "rest"), "voice.opus"), { kind: "audio", mime: "audio/ogg" });
    assert.deepEqual(sniffUpload(bytes("ID3", [4], "rest"), "lagu.mp3"), { kind: "audio", mime: "audio/mpeg" });
    const zip = bytes("PK", [3, 4], "rest");
    assert.equal(sniffUpload(zip, "arsip.zip"), undefined);
    assert.equal(sniffUpload(zip, "surat.docx")?.kind, "document");
    assert.deepEqual(sniffUpload(bytes("nama,omzet\nA,1"), "data.csv"), { kind: "document", mime: "text/csv" });
    assert.equal(sniffUpload(bytes("teks", [0], "biner"), "catatan.txt"), undefined);
    assert.equal(sniffUpload(bytes("<html>"), "halaman.html"), undefined);
    assert.equal(sniffUpload(bytes("MZ", [0x90]), "setup.exe"), undefined);
  });

  test("staging paths only accept generated ids", () => {
    assert.match(stagingPath("upload:0f8fad5b-d9cb-469f-a165-70867728950e"), /uploads\/0f8fad5b-d9cb-469f-a165-70867728950e$/);
    for (const bad of ["upload:../../etc/passwd", "upload:", "upload:0f8fad5b/../x"]) assert.throws(() => stagingPath(bad), bad);
  });

  test("links to Milo pages the model made up are removed, real ones kept", () => {
    const base = "https://app.secretary.my.id";
    const real = `${base}/u/${createUploadToken("21")}`;
    assert.equal(isInventedMiloLink(real, base), false);
    assert.equal(isInventedMiloLink(`${base}/u/rafaeljosh18`, base), true);
    assert.equal(isInventedMiloLink(`${base}/connect/${createUploadToken("21")}`, base), true, "an upload token does not open the Google page");
    assert.equal(isInventedMiloLink(`${base}/l/${createUploadToken("21")}`, base), true, "nor the location page");
    assert.equal(isInventedMiloLink(`${base}/l/lokasi-saya`, base), true);
    assert.equal(isInventedMiloLink("https://milo.id/u/rafaeljosh18", base), true);
    assert.equal(isInventedMiloLink("https://www.milo-ai.com/x", base), true);
    for (const fine of [`${base}/healthz`, "https://wa.me/6281234?text=halo", "https://www.reddit.com/u/milo", "https://docs.google.com/d/1", "https://camilo.dev"]) {
      assert.equal(isInventedMiloLink(fine, base), false, fine);
    }
    const reply = `Kirim lewat link ini ya: https://milo.id/u/rafaeljosh18.\nAtau yang ini: ${real}`;
    const { text, removed } = stripInventedLinks(reply, base);
    assert.deepEqual(removed, ["https://milo.id/u/rafaeljosh18"]);
    assert.equal(text, `Kirim lewat link ini ya: (link itu tidak valid; ketik *FILE* untuk link kirim file atau *KONEKSI* untuk link Google).\nAtau yang ini: ${real}`);
    assert.deepEqual(stripInventedLinks("tanpa link", base), { text: "tanpa link", removed: [] });
  });

  test("the page escapes the assistant name", () => {
    const html = uploadPage({ assistantName: '<img src=x onerror="alert(1)">', expiresText: "besok", maxMb: 25 });
    assert.ok(!html.includes("<img src=x"));
    assert.match(html, /Kirim file ke &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(uploadPage({ expired: true }), /Link sudah tidak berlaku/);
  });
});
