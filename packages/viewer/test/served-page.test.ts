/**
 * `kona view` serves a page a browser can actually load — from ANY directory.
 *
 * This is a subprocess test, and it has to be. The bug it pins lived in the seam between the
 * CLI and this package: Bun computes the bundled HTML's asset hrefs from `process.cwd()`, on
 * the first request, and caches them. `kona view` runs from whatever pursuit the operator is
 * standing in, so from `/tmp/thursday` the page came back asking for
 *
 *   `/../../../../../../../private/tmp/thursday/chunk-50chekzd.js`
 *
 * — seven `..`, because `packages/viewer` is seven segments deep. That escapes the server
 * root, falls through to the `/*` catch-all, and is answered with the index page as
 * `text/html`. The module script never executes, `#root` stays empty, and a perfectly healthy
 * `/api/log` sits behind a white screen.
 *
 * ## Why every other test missed it
 *
 * From any ANCESTOR of `packages/viewer` the `..` segments clamp at `/` and resolve correctly
 * — and `bun test`, `bun run dev` and every manual check run from the repo root. The existing
 * `kona view` unit test injects a fake `serveViewer`, so it never bundles anything at all.
 * Nothing in the suite had ever asked for this page from a directory a real pursuit lives in.
 *
 * So this test spawns the real binary, from a real pursuit in a temp directory, and fetches
 * the page the way a browser would. A 200 is not enough: the failure served 200s. What
 * distinguishes them is the CONTENT TYPE — `text/html` where JavaScript was asked for.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BIN = join(REPO, "packages", "kona", "src", "bin.ts");

const pursuit = mkdtempSync(join(tmpdir(), "kona-served-"));
let viewer: ReturnType<typeof Bun.spawn> | null = null;

afterAll(() => {
  viewer?.kill();
  rmSync(pursuit, { recursive: true, force: true });
});

/** Wait for the URL the verb prints, or fail with whatever it said instead. */
async function start(): Promise<string> {
  Bun.spawnSync({
    cmd: ["bun", BIN, "init", "--prefix", "t"],
    cwd: pursuit,
    stdout: "pipe",
    stderr: "pipe",
  });
  viewer = Bun.spawn(["bun", BIN, "view", "--port", "0", "--json"], {
    cwd: pursuit,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
  });

  const out: unknown = viewer.stdout;
  if (!(out instanceof ReadableStream)) {
    throw new Error("kona view was spawned without a piped stdout");
  }
  const reader = (out as ReadableStream<Uint8Array>).getReader();
  const deadline = Date.now() + 30_000;
  let buffered = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += new TextDecoder().decode(value);
    const parsed = /\{"ok":true,"url":"([^"]+)"/.exec(buffered);
    if (parsed?.[1] !== undefined) return parsed[1];
  }
  throw new Error(`kona view printed no url in 30s. It said: ${buffered || "(nothing)"}`);
}

const url = await start();

describe("the page kona view serves from a pursuit directory", () => {
  test("it is a real document, not an error page", async () => {
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('<div id="root">');
  });

  test("every asset href is root-relative — none climbs out of the server root", async () => {
    const html = await (await fetch(url)).text();
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? "");
    // Guard the premise: a page with no assets would satisfy the loop below vacuously.
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) {
      expect(`${ref} climbs out: ${String(ref.includes(".."))}`).toBe(`${ref} climbs out: false`);
      expect(`${ref} is absolute: ${String(ref.startsWith("/"))}`).toBe(`${ref} is absolute: true`);
    }
  });

  test("and each one comes back as the ASSET, not as the index page", async () => {
    // The whole failure in one assertion. The broken build answered these with 200 and
    // `text/html` — the catch-all serving the index page where a module script was asked for,
    // which a browser silently refuses to execute.
    const html = await (await fetch(url)).text();
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? "");
    for (const ref of refs) {
      const asset = await fetch(new URL(ref, url));
      const type = (asset.headers.get("content-type") ?? "").split(";")[0] ?? "";
      const expected = ref.endsWith(".css") ? "text/css" : "text/javascript";
      expect(`${ref} -> ${String(asset.status)} ${type}`).toBe(`${ref} -> 200 ${expected}`);
      // And it is the real bundle, not a stub: both are hundreds of kilobytes.
      const bytes = (await asset.arrayBuffer()).byteLength;
      expect(`${ref} is substantial: ${String(bytes > 10_000)}`).toBe(
        `${ref} is substantial: true`,
      );
    }
  });

  test("the read contract is served from that same pursuit", async () => {
    // Proof the page and the data agree about which pursuit this is — a viewer that renders
    // someone else's log would be worse than one that renders nothing.
    const log = await fetch(new URL("/api/log", url));
    expect(log.status).toBe(200);
    const text = await log.text();
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(text.trim()).v).toBe(0);
  });
});
