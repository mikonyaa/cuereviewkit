import { spawn } from "node:child_process";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
await mkdir("docs/demo", { recursive: true });
const dwell = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(process.execPath, ["scripts/serve.mjs", "--port", "0"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("Server timeout")), 10_000);
    child.stdout.on("data", (c) => {
      out += c;
      if (out.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(out.trim().split("\n")[0]).url);
      }
    });
    child.on("error", reject);
  });
  browser = await chromium.launch();
  const ctx = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      recordVideo: {
        dir: "artifacts/video",
        size: { width: 1440, height: 960 },
      },
    }),
    page = await ctx.newPage();
  const video = page.video();
  await page.goto(url);
  await page.screenshot({ path: "docs/demo/01-import.png" });
  await dwell(3000);
  await page
    .getByLabel("Source subtitles", { exact: true })
    .setInputFiles("examples/source.srt");
  await page
    .getByLabel("Translated subtitles", { exact: true })
    .setInputFiles("examples/translation.srt");
  await page.getByRole("button", { name: "Start review", exact: true }).click();
  await page.getByRole("button", { name: /Review n:1 group/ }).click();
  await page
    .getByLabel("Comment", { exact: true })
    .fill(
      "Intentional merge: two adjacent source cues form one translated cue.",
    );
  await page
    .getByRole("button", { name: "Accept translation", exact: true })
    .click();
  await page.screenshot({ path: "docs/demo/02-merge.png" });
  await dwell(4000);
  await page
    .getByRole("button", { name: "Unmatched intervals", exact: true })
    .click();
  await page.screenshot({ path: "docs/demo/03-unmatched.png" });
  await dwell(4000);
  await page
    .getByRole("button", { name: "Number evidence", exact: true })
    .click();
  await page.screenshot({ path: "docs/demo/04-number.png" });
  await dwell(4000);
  await page
    .getByRole("button", { name: "Export handoff", exact: true })
    .click();
  const wait = page.waitForEvent("download");
  await page.getByRole("button", { name: /Reviewer report/ }).click();
  const download = await wait;
  await download.saveAs("docs/demo/reviewer-report.html");
  await page.screenshot({ path: "docs/demo/05-export.png" });
  await dwell(6000);
  await ctx.close();
  const raw = await video.path();
  await copyFile(raw, "docs/demo/review-flow.webm");
  await writeFile(
    "docs/demo/sequence.json",
    JSON.stringify(
      {
        synthetic: true,
        browser: await browser.version(),
        frames: [
          "01-import.png",
          "02-merge.png",
          "03-unmatched.png",
          "04-number.png",
          "05-export.png",
        ],
        flow: [
          "import 240/239",
          "accept legal merge",
          "show unmatched interval",
          "show 100→1000",
          "export report",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Real browser recording and sequential screenshots saved.");
} finally {
  await browser?.close();
  child.kill("SIGTERM");
}
