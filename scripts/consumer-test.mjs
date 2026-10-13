import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { unzipSync } from "fflate";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const zipPath =
  process.env.CUEREVIEW_ZIP || "artifacts/CueReviewKit-0.1.0-web.zip";
const bytes = new Uint8Array(await readFile(zipPath));
const source = Buffer.from(
  "1\n00:00:01,000 --> 00:00:02,000\nBoard the local tram.\n\n2\n00:00:02,000 --> 00:00:03,000\nBring 100 tickets.\n\n3\n00:00:05,000 --> 00:00:07,000\nMeet at the south entrance.\n\n",
);
const translation = Buffer.from(
  "90\n00:00:01,000 --> 00:00:03,000\nBoard the tram and bring 1000 tickets.\n\n95\n00:00:05,000 --> 00:00:07,000\nMeet at the south entrance.\n\n",
);
const reasoning =
  "Offline merge reasoning. <script>window.reviewAttack=1</script>";
const reviewer = "Consumer reviewer";
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
    errors = [],
    externalRequests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  context.on("request", (r) => {
    if (!r.url().startsWith(url) || r.method() !== "GET")
      externalRequests.push(`${r.method()} ${r.url()}`);
  });
  await page.goto(url);
  await page.reload();
  await page.getByLabel("Source subtitles", { exact: true }).setInputFiles({
    name: "consumer-source.srt",
    mimeType: "text/plain",
    buffer: source,
  });
  await page.getByLabel("Translated subtitles", { exact: true }).setInputFiles({
    name: "consumer-translation.srt",
    mimeType: "text/plain",
    buffer: translation,
  });
  await page.getByRole("button", { name: "Start review", exact: true }).click();
  await page.getByRole("button", { name: /Review n:1 group/ }).click();
  await page
    .getByRole("button", { name: "Split current mapping", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Review unmatched group/ })
    .first()
    .waitFor();
  for (let i = 0; i < 3; i++)
    await page.locator(".group-row input").nth(i).check();
  await page
    .getByRole("button", { name: "Merge selected mapping", exact: true })
    .click();
  await page.getByRole("button", { name: /Review n:1 group/ }).click();
  const editor = page.locator(".decision-editor").first();
  await editor
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill(reasoning);
  await editor.getByRole("textbox", { name: /Reviewer name/ }).fill(reviewer);
  await page
    .getByRole("button", { name: "Accept translation", exact: true })
    .click();
  await page.locator(".group-select[aria-current=true]").focus();
  await page.keyboard.press("a");
  await page
    .getByRole("button", { name: "Number evidence", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Edit translation cue/ })
    .first()
    .click();
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
  assert.equal(
    await editor
      .getByRole("textbox", { name: "Comment", exact: true })
      .inputValue(),
    reasoning,
  );
  assert.ok((await page.locator(".state-tag.stale").count()) > 0);
  await page
    .getByRole("button", { name: "Export handoff", exact: true })
    .click();
  const wait = page.waitForEvent("download");
  await page.getByRole("button", { name: /Review package/ }).click();
  const download = await wait,
    packageFile = path.join(directory, "consumer.cue-review.zip");
  await download.saveAs(packageFile);
  const packageFiles = unzipSync(new Uint8Array(await readFile(packageFile)));
  const review = JSON.parse(
    new TextDecoder().decode(packageFiles["review.json"]),
  );
  assert.equal(review.decisions.length, 1);
  assert.ok(Array.isArray(review.manualMapping));
  assert.equal(review.decisions[0].comment, reasoning);
  assert.equal(review.decisions[0].reviewer, reviewer);
  assert.notEqual(review.decisions[0].reviewRevision, review.revision);
  assert.deepEqual(Buffer.from(packageFiles["originals/source.srt"]), source);
  assert.deepEqual(
    Buffer.from(packageFiles["originals/translation.srt"]),
    translation,
  );
  const correctedWait = page.waitForEvent("download");
  await page
    .getByRole("button", { name: /Corrected translation copy/ })
    .click();
  const correctedFile = path.join(directory, "consumer.corrected.srt");
  await (await correctedWait).saveAs(correctedFile);
  const corrected = await readFile(correctedFile, "utf8");
  assert.ok(corrected.includes("100 tickets") && !corrected.includes("1000"));
  assert.deepEqual(
    Buffer.from(packageFiles["working/translation.srt"]),
    Buffer.from(corrected),
  );
  const clean = await browser.newContext(),
    reopened = await clean.newPage();
  reopened.on("pageerror", (e) => errors.push(e.message));
  clean.on("request", (r) => {
    if (
      (!r.url().startsWith(url) && !r.url().startsWith("file:")) ||
      r.method() !== "GET"
    )
      externalRequests.push(`${r.method()} ${r.url()}`);
  });
  await reopened.goto(url);
  await reopened
    .getByLabel("Open review package", { exact: true })
    .setInputFiles(packageFile);
  await reopened
    .getByRole("button", { name: "Open as separate review", exact: true })
    .click();
  assert.ok((await reopened.locator(".state-tag.stale").count()) > 0);
  assert.equal(
    await reopened
      .locator(".decision-editor")
      .first()
      .getByRole("textbox", { name: "Comment", exact: true })
      .inputValue(),
    reasoning,
  );
  assert.equal(
    await reopened
      .locator(".decision-editor")
      .first()
      .getByRole("textbox", { name: /Reviewer name/ })
      .inputValue(),
    reviewer,
  );
  await reopened
    .getByRole("button", { name: "Export handoff", exact: true })
    .click();
  const reportWait = reopened.waitForEvent("download");
  await reopened.getByRole("button", { name: /Reviewer report/ }).click();
  const report = await reportWait,
    reportFile = path.join(directory, "report.html");
  await report.saveAs(reportFile);
  await reopened
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await reopened
    .locator(".workspace-footer")
    .filter({ hasText: "Recovery saved locally" })
    .waitFor();
  await reopened.reload();
  await reopened
    .getByRole("button", { name: "Restore recovery", exact: true })
    .click();
  await reopened.locator(".decision-editor").first().waitFor();
  assert.equal(
    await reopened
      .locator(".decision-editor")
      .first()
      .getByRole("textbox", { name: "Comment", exact: true })
      .inputValue(),
    reasoning,
  );
  await clean.setOffline(true);
  assert.equal(
    await reopened
      .locator(".decision-editor")
      .first()
      .getByRole("textbox", { name: /Reviewer name/ })
      .inputValue(),
    reviewer,
  );
  const reportPage = await clean.newPage();
  reportPage.on("pageerror", (e) => errors.push(e.message));
  await reportPage.goto("file://" + reportFile);
  assert.equal(
    await reportPage
      .getByRole("heading", { name: "Subtitle review report", exact: true })
      .count(),
    1,
  );
  assert.equal(await reportPage.locator("script").count(), 0);
  assert.ok((await readFile(reportFile, "utf8")).includes("&lt;script&gt;"));
  assert.equal(await reportPage.evaluate(() => window.reviewAttack), undefined);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/consumer.cue-review.zip",
    await readFile(packageFile),
  );
  await writeFile("artifacts/consumer-report.html", await readFile(reportFile));
  await writeFile("artifacts/consumer.corrected.srt", corrected);
  await writeFile(
    "artifacts/consumer-result.json",
    JSON.stringify(
      {
        status: "passed",
        archive: zipPath,
        archiveBytes: bytes.length,
        archiveSha256: createHash("sha256").update(bytes).digest("hex"),
        sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        files: Object.keys(files).length,
        sourceDependenciesPresent: false,
        mount: "/cuereviewkit/",
        checks: [
          "loopback server",
          "path traversal",
          "hard refresh",
          "pair import",
          "manual split/merge",
          "merge approval with comment and reviewer",
          "shortcut preserves reasoning",
          "numeric edit",
          "exact original bytes",
          "stale",
          "export",
          "clean context reopen",
          "recovery comment/reviewer",
          "corrected bytes equal package working bytes",
          "offline file report with escaped hostile comment",
          "no uploads or external requests",
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
