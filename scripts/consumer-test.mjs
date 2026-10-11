import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { unzipSync } from "fflate";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const zipPath =
  process.env.CUEREVIEW_ZIP || "artifacts/CueReviewKit-0.1.0-web.zip";
const bytes = new Uint8Array(await readFile(zipPath));
assert.equal(bytes[0], 0x50);
assert.equal(bytes[1], 0x4b);
const directory = await mkdtemp(path.join(tmpdir(), "cuereviewkit-consumer-")),
  files = unzipSync(bytes);
let total = 0;
for (const [name, data] of Object.entries(files)) {
  assert.match(
    name,
    /^(?:app\/[\w./-]+|examples\/[\w.-]+|serve\.mjs|README-OFFLINE\.md|LICENSE|THIRD_PARTY_NOTICES\.md)$/,
  );
  assert.ok(!name.split("/").includes(".."));
  total += data.length;
  assert.ok(total < 60 * 1024 ** 2);
  const target = path.join(directory, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
}
assert.ok(!files["package.json"]);
assert.ok(!Object.keys(files).some((name) => name.includes("node_modules")));
const child = spawn(
  process.execPath,
  ["serve.mjs", "--port", "0", "--mount", "/cuereviewkit/"],
  { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
);
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(
      () => reject(new Error("Packaged server startup timed out")),
      10_000,
    );
    child.stdout.on("data", (chunk) => {
      text += chunk.toString();
      if (text.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(text.trim().split("\n")[0]).url);
      }
    });
    child.on("error", reject);
  });
  const unsafe = await fetch(url + "%2e%2e%2fLICENSE");
  assert.equal(unsafe.status, 400);
  const privateFile = await fetch(url + "../package.json");
  assert.notEqual(privateFile.status, 200);
  browser = await chromium.launch();
  const context = await browser.newContext(),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.reload();
  await page
    .getByLabel("Source subtitles", { exact: true })
    .setInputFiles(path.join(directory, "examples/source.srt"));
  await page
    .getByLabel("Translated subtitles", { exact: true })
    .setInputFiles(path.join(directory, "examples/translation.srt"));
  await page.getByRole("button", { name: "Start review", exact: true }).click();
  await page.getByRole("button", { name: /Review n:1 group/ }).click();
  await page
    .getByRole("button", { name: "Accept translation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Number evidence", exact: true })
    .click();
  await page.getByRole("button", { name: /Edit translation cue/ }).click();
  const text = await page
    .getByLabel("Translation text", { exact: true })
    .inputValue();
  await page
    .getByLabel("Translation text", { exact: true })
    .fill(text.replace("1000", "100"));
  await page
    .getByRole("button", { name: "Preview change", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply correction", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByRole("button", { name: /Stale decisions/ }).click();
  assert.ok((await page.locator(".state-tag.stale").count()) > 0);
  await page
    .getByRole("button", { name: "Export handoff", exact: true })
    .click();
  const wait = page.waitForEvent("download");
  await page.getByRole("button", { name: /Review package/ }).click();
  const download = await wait,
    packageFile = path.join(directory, "consumer.cue-review.zip");
  await download.saveAs(packageFile);
  const clean = await browser.newContext(),
    reopened = await clean.newPage();
  await reopened.goto(url);
  await reopened
    .getByLabel("Open review package", { exact: true })
    .setInputFiles(packageFile);
  await reopened
    .getByRole("button", { name: "Open as separate review", exact: true })
    .click();
  assert.ok((await reopened.locator(".state-tag.stale").count()) > 0);
  await reopened
    .getByRole("button", { name: "Export handoff", exact: true })
    .click();
  const reportWait = reopened.waitForEvent("download");
  await reopened.getByRole("button", { name: /Reviewer report/ }).click();
  const report = await reportWait,
    reportFile = path.join(directory, "report.html");
  await report.saveAs(reportFile);
  const reportPage = await clean.newPage();
  await reportPage.goto("file://" + reportFile);
  assert.equal(
    await reportPage
      .getByRole("heading", { name: "Subtitle review report", exact: true })
      .count(),
    1,
  );
  assert.equal(await reportPage.locator("script").count(), 0);
  assert.deepEqual(errors, []);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/consumer-result.json",
    JSON.stringify(
      {
        status: "passed",
        archive: zipPath,
        archiveBytes: bytes.length,
        files: Object.keys(files).length,
        sourceDependenciesPresent: false,
        mount: "/cuereviewkit/",
        checks: [
          "loopback server",
          "path traversal",
          "hard refresh",
          "pair import",
          "merge approval",
          "numeric edit",
          "stale",
          "export",
          "clean context reopen",
          "file report",
        ],
        browser: await browser.version(),
        node: process.version,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Final ZIP consumer flow passed outside the source workspace, without npm install.",
  );
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  await rm(directory, { recursive: true, force: true });
}
