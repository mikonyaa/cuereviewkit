import { test, expect } from "./fixture";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { decodeZip, encodeZip } from "../../src/package/zip";
import { sha256 } from "../../src/review/hash";
import { importPackage } from "../../src/package";
const root = process.cwd(),
  enc = new TextEncoder();
const sample = (text: string) => Buffer.from(text);
const smallSource =
  "1\n00:00:01,000 --> 00:00:02,000\nTake the tram.\n\n2\n00:00:02,000 --> 00:00:03,000\nBring 100 tickets.\n\n3\n00:00:05,000 --> 00:00:06,000\nMeet at the entrance.\n\n";
const smallTarget =
  "90\n00:00:01,000 --> 00:00:03,000\nСадись в трамвай. Возьми 1000 билетов.\n\n";
test("import → legal merge → number correction → stale → safe exports → clean-context reopen", async ({
  page,
  browser,
  appUrl,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(appUrl);
  await page
    .getByLabel("Source subtitles", { exact: true })
    .setInputFiles(path.join(root, "fixtures/feasibility-source.srt"));
  await page
    .getByLabel("Translated subtitles", { exact: true })
    .setInputFiles(path.join(root, "fixtures/feasibility-translation.srt"));
  await page.getByRole("button", { name: "Start review", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Review n:1 group/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Accept translation", exact: true })
    .click();
  await expect(
    page
      .locator(".decision-editor")
      .first()
      .getByText("accepted", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit translation cue 1", exact: true })
    .click();
  await page
    .getByLabel("Translation text", { exact: true })
    .fill("Садись в трамвай. Возьми 100 билетов.");
  await page
    .getByRole("button", { name: "Preview change", exact: true })
    .click();
  await expect(page.getByText("Before", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Apply correction", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page
      .locator(".decision-editor")
      .first()
      .getByText("stale", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Unmatched intervals", exact: true })
    .click();
  await expect(
    page.getByText("No corresponding translation interval."),
  ).toBeVisible();
  await page.getByRole("button", { name: /All groups/ }).click();
  await page
    .getByRole("button", { name: "Export handoff", exact: true })
    .click();
  const origPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Untouched source/ }).click();
  const original = await origPromise;
  expect(await readFile((await original.path())!)).toEqual(
    Buffer.from(enc.encode(smallSource)),
  );
  const corrPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: /Corrected translation copy/ })
    .click();
  const corrected = await corrPromise;
  expect(await readFile((await corrected.path())!, "utf8")).toContain(
    "100 билетов",
  );
  expect(corrected.suggestedFilename()).toBe(
    "feasibility-translation.corrected.srt",
  );
  const pkgPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Review package/ }).click();
  const pkg = await pkgPromise,
    pkgPath = (await pkg.path())!;
  const files = decodeZip(new Uint8Array(await readFile(pkgPath)));
  expect(files["originals/translation.srt"]).toEqual(enc.encode(smallTarget));
  const restored = await importPackage(new Uint8Array(await readFile(pkgPath)));
  expect(restored.session.analysis.working[0].text).toContain("100 билетов");
  const reportPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Reviewer report", exact: false })
    .click();
  const report = await reportPromise;
  const reportPath = path.join(
    root,
    "artifacts",
    `report-${testInfo.project.name}.html`,
  );
  await mkdir(path.dirname(reportPath), { recursive: true });
  await report.saveAs(reportPath);
  const reportContext = await browser.newContext(),
    reportPage = await reportContext.newPage();
  await reportPage.goto("file://" + reportPath);
  await expect(
    reportPage.getByRole("heading", {
      name: "Subtitle review report",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    reportPage.getByText(/stale \(previously accepted\)/),
  ).toBeVisible();
  expect(await reportPage.locator("script").count()).toBe(0);
  await reportContext.close();
  await page.close();
  const clean = await browser.newContext(),
    reopened = await clean.newPage();
  await reopened.goto(appUrl);
  await reopened
    .getByLabel("Open review package", { exact: true })
    .setInputFiles(pkgPath);
  await expect(
    reopened.getByRole("heading", { name: "Verified package preview" }),
  ).toBeVisible();
  await reopened
    .getByRole("button", { name: "Open as separate review", exact: true })
    .click();
  await expect(
    reopened
      .locator(".decision-editor")
      .first()
      .getByText("stale", { exact: true }),
  ).toBeVisible();
  await expect(
    reopened.getByText("Садись в трамвай. Возьми 100 билетов.", {
      exact: true,
    }),
  ).toBeVisible();
  await clean.close();
  expect(errors).toEqual([]);
});
test("checksum-valid hostile HTML is ignored; failed malicious package leaves the current review intact", async ({
  page,
  appUrl,
}) => {
  const files = decodeZip(
    new Uint8Array(await readFile("examples/sample.cue-review.zip")),
  );
  files["report.html"] = enc.encode(
    '<script>window.CUEREVIEW_ATTACK_EXECUTED=true</script><img src=x onerror="window.CUEREVIEW_ATTACK_EXECUTED=true">',
  );
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  for (const entry of manifest.files)
    if (entry.path === "report.html") {
      entry.bytes = files["report.html"].length;
      entry.sha256 = await sha256(files["report.html"]);
    }
  files["manifest.json"] = enc.encode(JSON.stringify(manifest));
  await page.goto(appUrl);
  await page.getByLabel("Open review package", { exact: true }).setInputFiles({
    name: "hostile.cue-review.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(encodeZip(files)),
  });
  await page
    .getByRole("button", { name: "Open as separate review", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      Object.prototype.hasOwnProperty.call(window, "CUEREVIEW_ATTACK_EXECUTED"),
    ),
  ).toBe(false);
  await page
    .getByRole("button", { name: "Accepted groups", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Export handoff", exact: true })
    .click();
  const wait = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Reviewer report/ }).click();
  const download = await wait;
  expect(await readFile((await download.path())!, "utf8")).not.toContain(
    "CUEREVIEW_ATTACK_EXECUTED",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByLabel("Open review package", { exact: true }).setInputFiles({
    name: "bad.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("not a zip"),
  });
  await expect(page.locator(".announcement")).toContainText(
    "Package must be a ZIP",
  );
  await expect(page.locator(".track-label").first()).toContainText(
    "source.srt",
  );
  await expect(
    page
      .locator(".decision-editor")
      .first()
      .getByText("accepted", { exact: true }),
  ).toBeVisible();
});
test("unsupported STYLE preserves original bytes, clear diagnostics and blocked corrected export", async ({
  page,
  appUrl,
}) => {
  const vtt =
    "WEBVTT\r\n\r\nSTYLE\r\n::cue {color:red}\r\n\r\n00:01.000 --> 00:02.000\r\nHello\r\n";
  await page.goto(appUrl);
  await page.getByLabel("Source subtitles", { exact: true }).setInputFiles({
    name: "source.vtt",
    mimeType: "text/vtt",
    buffer: sample("WEBVTT\n\n00:01.000 --> 00:02.000\nHello\n"),
  });
  await page.getByLabel("Translated subtitles", { exact: true }).setInputFiles({
    name: "style.vtt",
    mimeType: "text/vtt",
    buffer: sample(vtt),
  });
  await page.getByRole("button", { name: "Start review", exact: true }).click();
  await expect(
    page.getByText("Unsupported or malformed format", { exact: true }),
  ).toBeVisible();
  await page.getByText("Read format diagnostics", { exact: true }).click();
  await expect(page.getByText(/STYLE blocks are preserved/)).toBeVisible();
  await page
    .getByRole("button", { name: "Export handoff", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Corrected translation copy/ }),
  ).toBeDisabled();
  const promise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Untouched translation/ }).click();
  const download = await promise;
  expect(await readFile((await download.path())!)).toEqual(
    Buffer.from(enc.encode(vtt)),
  );
});
test("invalid edit keeps draft, split/merge and presets invalidate approvals, keyboard ignores text fields", async ({
  page,
  appUrl,
}) => {
  await page.goto(appUrl);
  await page
    .getByRole("button", { name: "Try synthetic example", exact: true })
    .click();
  await expect(page.getByText("240 cues", { exact: false })).toBeVisible();
  await page
    .getByRole("button", { name: "Accept translation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit translation cue 1", exact: true })
    .click();
  await page
    .getByLabel("Translation text", { exact: true })
    .fill("Draft\n\nInjected");
  await expect(page.getByText(/Blank separator lines/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply correction", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Translation text", { exact: true }).press("a");
  await expect(
    page.getByLabel("Translation text", { exact: true }),
  ).toContainText("");
  expect(
    await page.getByLabel("Translation text", { exact: true }).inputValue(),
  ).toContain("a");
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  await page
    .getByRole("button", { name: "Split current mapping", exact: true })
    .click();
  await expect(page.locator(".workspace-footer")).toContainText(
    "Recovery saved locally",
  );
  await page.getByRole("button", { name: /Stale decisions/ }).click();
  await expect(page.locator(".group-row")).toHaveCount(0); // The reviewed group no longer exists; stale decisions remain counted.
  await page.getByRole("button", { name: /All groups/ }).click();
  const boxes = page.locator(".group-row input[type=checkbox]");
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page
    .getByRole("button", { name: "Merge selected mapping", exact: true })
    .click();
  await expect(page.locator(".workspace-footer")).toContainText(
    "Recovery saved locally",
  );
  await page.getByRole("button", { name: "Rule preset", exact: true }).click();
  await page.getByLabel("Maximum CPS", { exact: true }).fill("20");
  await page.getByRole("button", { name: "Apply preset", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("/");
  await expect(
    page.getByLabel("Search subtitle text", { exact: true }),
  ).toBeFocused();
});
test("storage failure preserves edits and portable export; two tabs detect conflict", async ({
  page,
  context,
  appUrl,
}) => {
  await page.goto(appUrl);
  const second = await context.newPage();
  await second.goto(appUrl);
  await page
    .getByRole("button", { name: "Try synthetic example", exact: true })
    .click();
  await expect(page.locator(".workspace-footer")).toContainText(
    "Recovery saved locally",
  );
  await second
    .getByRole("button", { name: "Try synthetic example", exact: true })
    .click();
  await expect(second.locator(".workspace-footer")).toContainText(
    "Storage conflict",
  );
  await second
    .getByRole("button", { name: "Accept translation", exact: true })
    .click();
  await expect(
    second
      .locator(".decision-editor")
      .first()
      .getByText("accepted", { exact: true }),
  ).toBeVisible();
  await second
    .getByRole("button", { name: "Export handoff", exact: true })
    .click();
  const wait = second.waitForEvent("download");
  await second.getByRole("button", { name: /Review package/ }).click();
  expect((await wait).suggestedFilename()).toBe("review.cue-review.zip");
  await second.close();
});
test("failed IndexedDB transaction still permits handoff and recovery from successful save", async ({
  page,
  browser,
  appUrl,
}) => {
  await page.addInitScript(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      if (args[1] === "readwrite")
        throw new DOMException("Synthetic quota failure", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await page.goto(appUrl);
  await page
    .getByRole("button", { name: "Try synthetic example", exact: true })
    .click();
  await expect(page.locator(".workspace-footer")).toContainText(
    "Synthetic quota failure",
  );
  await page
    .getByRole("button", { name: "Accept translation", exact: true })
    .click();
  await expect(
    page
      .locator(".decision-editor")
      .first()
      .getByText("accepted", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Export handoff", exact: true })
    .click();
  const wait = page.waitForEvent("download");
  await page.getByRole("button", { name: /Review package/ }).click();
  const download = await wait;
  const ctx = await browser.newContext(),
    p = await ctx.newPage();
  await p.goto(appUrl);
  await p
    .getByLabel("Open review package", { exact: true })
    .setInputFiles((await download.path())!);
  await p
    .getByRole("button", { name: "Open as separate review", exact: true })
    .click();
  await expect(p.locator(".workspace-footer")).toContainText(
    "Recovery saved locally",
  );
  await p.reload();
  await p
    .getByRole("button", { name: "Restore recovery", exact: true })
    .click();
  await expect(
    p
      .locator(".decision-editor")
      .first()
      .getByText("accepted", { exact: true }),
  ).toBeVisible();
  await ctx.close();
});
test("desktop 1440/1024 and mobile 390 handle RTL/CJK, long text, empty input and focus without clipping", async ({
  page,
  appUrl,
}, testInfo) => {
  await page.goto(appUrl);
  await page.getByLabel("Source subtitles", { exact: true }).setInputFiles({
    name: "unicode.srt",
    mimeType: "text/plain",
    buffer: sample(
      "1\n00:00:01,000 --> 00:00:05,000\nمرحبا بكم · 你好 世界\n\n2\n00:00:06,000 --> 00:00:10,000\n" +
        "LongWord".repeat(250) +
        "\n",
    ),
  });
  await page.getByLabel("Translated subtitles", { exact: true }).setInputFiles({
    name: "rtl.srt",
    mimeType: "text/plain",
    buffer: sample(
      "1\n00:00:01,000 --> 00:00:05,000\nשלום לכולם · 欢迎朋友\n\n2\n00:00:06,000 --> 00:00:10,000\n" +
        "长句".repeat(1000) +
        "\n",
    ),
  });
  await page.getByRole("button", { name: "Start review", exact: true }).click();
  await mkdir("artifacts/qa", { recursive: true });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(
      page.getByRole("button", { name: "Export handoff", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/qa/rtl-${testInfo.project.name}-${width}.png`,
      fullPage: true,
    });
  }
  await page
    .getByRole("button", { name: /Review 1:1 group at 00:00:06/ })
    .click();
  await page.screenshot({
    path: `artifacts/qa/long-${testInfo.project.name}-390.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Import pair", exact: true }).click();
  await page.getByLabel("Source subtitles", { exact: true }).setInputFiles({
    name: "empty.srt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(0),
  });
  await page.getByLabel("Translated subtitles", { exact: true }).setInputFiles({
    name: "empty.srt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(0),
  });
  await page.getByRole("button", { name: "Start review", exact: true }).click();
  await expect(page.getByText("No groups in this view.")).toBeVisible();
});
