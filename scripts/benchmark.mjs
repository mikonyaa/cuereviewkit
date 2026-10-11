import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const child = spawn(process.execPath, ["scripts/serve.mjs", "--port", "0"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
const stamp = (ms) => {
  const h = Math.floor(ms / 3600000),
    m = Math.floor(ms / 60000) % 60,
    s = Math.floor(ms / 1000) % 60,
    x = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(x).padStart(3, "0")}`;
};
const make = (count, dense) =>
  Buffer.from(
    Array.from(
      { length: count },
      (_, i) =>
        `${i + 1}\n${stamp(dense ? 0 : i * 2000)} --> ${stamp(dense ? 2000 : i * 2000 + 1500)}\nSynthetic performance cue.\n\n`,
    ).join(""),
  );
try {
  const url = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      if (out.includes("\n"))
        resolve(JSON.parse(out.trim().split("\n")[0]).url);
    });
    child.on("error", reject);
  });
  browser = await chromium.launch({ args: ["--enable-precise-memory-info"] });
  const results = [];
  for (const [count, dense] of [
    [5000, false],
    [20000, false],
    [20000, true],
  ]) {
    const context = await browser.newContext(),
      page = await context.newPage();
    await page.goto(url);
    await page.evaluate(() => {
      let last = performance.now();
      globalThis.bench = { ticks: 0, maxGapMs: 0 };
      globalThis.benchTimer = setInterval(() => {
        const now = performance.now();
        globalThis.bench.ticks++;
        globalThis.bench.maxGapMs = Math.max(
          globalThis.bench.maxGapMs,
          now - last,
        );
        last = now;
      }, 16);
    });
    const bytes = make(count, dense);
    await page.getByLabel("Source subtitles", { exact: true }).setInputFiles({
      name: "performance-source.srt",
      mimeType: "text/plain",
      buffer: bytes,
    });
    await page
      .getByLabel("Translated subtitles", { exact: true })
      .setInputFiles({
        name: "performance-target.srt",
        mimeType: "text/plain",
        buffer: bytes,
      });
    const start = performance.now();
    await page
      .getByRole("button", { name: "Start review", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Export handoff", exact: true })
      .waitFor({ timeout: 120000 });
    await page
      .locator(".announcement")
      .filter({ hasText: "Original pair imported" })
      .waitFor({ timeout: 120000 });
    const ms = performance.now() - start;
    let giantViewMs = null,
      materializedCueBlocks = null;
    if (dense) {
      const viewStart = performance.now();
      await page
        .getByRole("button", { name: "Ambiguous / large", exact: true })
        .click();
      await page.getByText("Next cues", { exact: true }).waitFor();
      giantViewMs = Math.round(performance.now() - viewStart);
      materializedCueBlocks = await page.locator(".cue-block").count();
      if (materializedCueBlocks > 100)
        throw new Error("Giant group was not paginated");
    }
    const stats = await page.evaluate(() => {
      clearInterval(globalThis.benchTimer);
      return {
        ...globalThis.bench,
        approximateMainThreadJsHeapBytes:
          performance.memory?.usedJSHeapSize ?? null,
      };
    });
    results.push({
      cuesPerTrack: count,
      dense,
      trackBytes: bytes.length,
      elapsedMs: Math.round(ms),
      giantViewMs,
      materializedCueBlocks,
      ...stats,
      incomplete:
        (await page.getByText("Incomplete analysis", { exact: true }).count()) >
        0,
    });
    await context.close();
  }
  const context = await browser.newContext(),
    page = await context.newPage();
  await page.goto(url);
  await page
    .getByRole("button", { name: "Try synthetic example", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Export handoff", exact: true })
    .waitFor();
  const bytes = make(20000, true);
  await page.getByLabel("Replace translation", { exact: true }).setInputFiles({
    name: "cancel.srt",
    mimeType: "text/plain",
    buffer: bytes,
  });
  await page
    .getByRole("button", { name: "Cancel calculation", exact: true })
    .click();
  await page
    .getByText("Calculation cancelled. Current review was kept.", {
      exact: true,
    })
    .waitFor();
  const cancelledKeptOriginal = await page
    .locator(".track-label")
    .nth(1)
    .textContent();
  if (!cancelledKeptOriginal.includes("translation.srt"))
    throw new Error("Cancel replaced the current track");
  await context.close();
  const hardware =
    process.platform === "darwin"
      ? execFileSync(
          "sysctl",
          ["-n", "machdep.cpu.brand_string", "hw.memsize"],
          { encoding: "utf8" },
        ).trim()
      : "CI Linux";
  await mkdir("docs/qa", { recursive: true });
  await writeFile(
    "docs/qa/performance.json",
    JSON.stringify(
      {
        machine: hardware,
        node: process.version,
        browser: await browser.version(),
        method:
          "Single local run; main-thread interval counts/gaps and non-standard Chromium performance.memory approximate JS heap only. Not total browser/worker RAM or a universal benchmark.",
        results,
        cancelledHeavyWorker: true,
        cancelledKeptOriginal,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(results));
} finally {
  await browser?.close();
  child.kill("SIGTERM");
}
