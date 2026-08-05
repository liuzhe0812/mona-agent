import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the five-item Mona landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Mona — 你的 AI 桌面搭档<\/title>/i);
  assert.match(html, /DIALOGUE \/ MONA/);
  assert.match(html, /CORE CAPABILITIES \/ MONA SYSTEM/);
  assert.match(html, /href="\/manual\.html"/);
  assert.match(html, /href="\/tutorial"/);
  assert.match(html, /href="\/changelog"/);
  assert.doesNotMatch(html, /Work(?: |&nbsp;|\u00a0)Buddy/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("server-renders restored tutorial and changelog pages", async () => {
  const [tutorial, changelog] = await Promise.all([
    render("/tutorial"),
    render("/changelog"),
  ]);
  assert.equal(tutorial.status, 200);
  assert.equal(changelog.status, 200);

  const [tutorialHtml, changelogHtml] = await Promise.all([
    tutorial.text(),
    changelog.text(),
  ]);
  assert.match(tutorialHtml, /FREE MODEL \/ 001/);
  assert.match(tutorialHtml, /FREE MODEL \/ OPTIONAL ROUTE/);
  assert.match(changelogHtml, /SYSTEM LOG \/ LIVE/);
  assert.match(changelogHtml, /v(?:<!-- -->)?1\.4\.0/);
});

test("restores the full manual and keeps the landing page accessible", async () => {
  const [page, css, manual, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../public/manual.html", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(manual, /Mona 用户手册/);
  assert.match(manual, /Mona official-site visual system/);
  assert.match(manual, /href="\/"/);
  assert.match(page, /event\.key === " "/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /aria-label="主菜单"/);
  assert.equal((page.match(/label: "/g) ?? []).length, 5);
  assert.match(css, /hero-concept-v3\.png/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
