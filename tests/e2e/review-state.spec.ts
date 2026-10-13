import { test, expect } from "./fixture";
import type { Page } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { importPackage } from "../../src/package";
import { decisionFor } from "../../src/review/engine";
import {
  installWorkerGate,
  installRepeatedSessionIdentity,
} from "./worker-gate";

function pair(label: string, count = 2) {
  return Buffer.from(
    Array.from({ length: count }, (_, i) => {
      const seconds = (n: number) =>
        `00:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")},000`;
      return `${i + 1}\n${seconds(i * 3 + 1)} --> ${seconds(i * 3 + 3)}\n${label} cue ${i + 1}.\n\n`;
    }).join(""),
  );
}
async function importPair(page: Page, label: string, count = 2) {
  if (
    await page.getByRole("button", { name: "Import pair", exact: true }).count()
  )
    await page
      .getByRole("button", { name: "Import pair", exact: true })
      .click();
  await page.getByLabel("Source subtitles", { exact: true }).setInputFiles({
    name: `${label.slice(0, 40)}-source.srt`,
    mimeType: "text/plain",
    buffer: pair(`${label} source`, count),
  });
  await page.getByLabel("Translated subtitles", { exact: true }).setInputFiles({
    name: `${label.slice(0, 40)}-translation.srt`,
    mimeType: "text/plain",
    buffer: pair(`${label} translation`, count),
  });
  await page.getByRole("button", { name: "Start review", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".workspace-footer")).toContainText(
    "Recovery saved locally",
  );
}
async function exported(page: Page) {
  await page
    .getByRole("button", { name: "Export handoff", exact: true })
    .click();
  const wait = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Review package/ }).click();
  const download = await wait;
  const path = (await download.path())!;
  const restored = await importPackage(new Uint8Array(await readFile(path)));
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return { ...restored, path };
}
const editor = (page: Page) => page.locator(".decision-editor").first();
async function recoverySessionId(page: Page) {
  await expect(page.locator(".workspace-footer")).toContainText(
    "Recovery saved locally",
  );
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open("cuereviewkit-v1", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("sessions", "readonly");
          const get = tx.objectStore("sessions").get("current");
          get.onsuccess = () => resolve(get.result.session.id);
          tx.oncomplete = () => db.close();
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}
async function correct(page: Page, text: string) {
  await page
    .getByRole("button", { name: "Edit translation cue 1", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Translation text", exact: true })
    .fill(text);
  await page
    .getByRole("button", { name: "Preview change", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply correction", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function capture(page: Page, name: string, engine: string) {
  await mkdir("artifacts/qa/review-state", { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/qa/review-state/${name}-${engine}-${width}.png`,
      fullPage: true,
    });
  }
}
async function acceptKey(page: Page) {
  await page.locator(".group-select[aria-current=true]").focus();
  await page.keyboard.press("a");
  await expect(editor(page).locator(".state-tag")).toHaveText("accepted");
}

test("accept shortcut preserves saved reasoning in package and recovery", async ({
  page,
  appUrl,
}) => {
  await page.goto(appUrl);
  await importPair(page, "A");
  await editor(page)
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Editorial reasoning A");
  await editor(page)
    .getByLabel(/Reviewer name/)
    .fill("Reviewer A");
  await editor(page)
    .getByRole("button", { name: "Accept translation", exact: true })
    .click();
  await acceptKey(page);
  const result = await exported(page);
  const d = decisionFor(result.session, "g:s0:t0");
  expect(d?.comment).toBe("Editorial reasoning A");
  expect(d?.reviewer).toBe("Reviewer A");
  await page.reload();
  await page
    .getByRole("button", { name: "Restore recovery", exact: true })
    .click();
  await expect(
    editor(page).getByRole("textbox", { name: "Comment", exact: true }),
  ).toHaveValue("Editorial reasoning A");
});

test("accept shortcut commits the current draft, including an intentional clear", async ({
  page,
  appUrl,
}) => {
  await page.goto(appUrl);
  await importPair(page, "Draft");
  await editor(page)
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Current unapplied reasoning");
  await editor(page)
    .getByLabel(/Reviewer name/)
    .fill("Draft reviewer");
  await acceptKey(page);
  expect(decisionFor((await exported(page)).session, "g:s0:t0")?.comment).toBe(
    "Current unapplied reasoning",
  );
  await editor(page)
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("");
  await editor(page)
    .getByLabel(/Reviewer name/)
    .fill("");
  await editor(page)
    .getByRole("button", { name: "Accept translation", exact: true })
    .click();
  const cleared = await exported(page);
  expect(decisionFor(cleared.session, "g:s0:t0")?.comment).toBe("");
  expect(decisionFor(cleared.session, "g:s0:t0")?.reviewer).toBe("");
});

test("a new pair with repeated ordinal IDs cannot inherit another material's draft", async ({
  page,
  appUrl,
}) => {
  await page.goto(appUrl);
  await importPair(page, "A");
  await editor(page)
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("A-only draft");
  const aSessionId = await recoverySessionId(page);
  await editor(page)
    .getByLabel(/Reviewer name/)
    .fill("Reviewer A");
  const a = await exported(page);
  await importPair(page, "B");
  await expect(
    editor(page).getByRole("textbox", { name: "Comment", exact: true }),
  ).toHaveValue("");
  await expect(editor(page).getByLabel(/Reviewer name/)).toHaveValue("");
  await acceptKey(page);
  const b = await exported(page);
  expect(await recoverySessionId(page)).not.toBe(aSessionId);
  expect(b.session.source.byteHash).not.toBe(a.session.source.byteHash);
  expect(b.session.translation.byteHash).not.toBe(
    a.session.translation.byteHash,
  );
  expect(decisionFor(b.session, "g:s0:t0")?.comment).toBe("");
});

test("opening the same package twice replaces unsaved drafts even with identical IDs and revision", async ({
  page,
  appUrl,
}) => {
  // Make runtime identities repeat too, independent of the package schema.
  await installRepeatedSessionIdentity(page);
  await page.goto(appUrl);
  await importPair(page, "Package");
  await editor(page)
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Saved package reasoning");
  await acceptKey(page);
  const pkg = await exported(page);
  const sessionId = await recoverySessionId(page);
  for (let i = 0; i < 2; i++) {
    await editor(page)
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("Unapplied replacement draft");
    await page
      .getByLabel("Open review package", { exact: true })
      .setInputFiles(pkg.path);
    await page
      .getByRole("button", { name: "Open as separate review", exact: true })
      .click();
    await expect(
      editor(page).getByRole("textbox", { name: "Comment", exact: true }),
    ).toHaveValue("Saved package reasoning");
    expect(await recoverySessionId(page)).toBe(sessionId);
  }
});

test("page two followed by a small import shows the new pair and keyboard navigation", async ({
  page,
  appUrl,
}) => {
  await page.goto(appUrl);
  await importPair(page, "Large", 120);
  await page.getByRole("button", { name: "Next 50", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await importPair(page, "Small", 2);
  await expect(page.locator(".group-row")).toHaveCount(2);
  await page.locator(".group-select[aria-current=true]").focus();
  await page.keyboard.press("j");
  await expect(
    page.locator(".group-select[aria-current=true]"),
  ).toHaveAttribute("aria-label", /00:00:04/);
  await page.keyboard.press("k");
  await expect(
    page.locator(".group-select[aria-current=true]"),
  ).toHaveAttribute("aria-label", /00:00:01/);
});

test("mapping shrink clamps the queue and changing pages keeps the active group visible", async ({
  page,
  appUrl,
}) => {
  await page.goto(appUrl);
  await importPair(page, "Mapping", 51);
  await page.locator(".group-row input").first().check();
  await page.getByRole("button", { name: "Next 50", exact: true }).click();
  await page.locator(".group-row input").last().check();
  await page
    .getByRole("button", { name: "Merge selected mapping", exact: true })
    .click();
  await expect(page.locator(".group-row")).toHaveCount(50);
  await expect(page.locator(".group-select[aria-current=true]")).toBeVisible();
  await page.getByLabel("Search subtitle text", { exact: true }).fill("cue 7.");
  await expect(page.locator(".group-row")).toHaveCount(1);
  await page
    .getByLabel("Search subtitle text", { exact: true })
    .fill("no match at all");
  await expect(page.locator(".group-row")).toHaveCount(0);
  await expect(page.locator(".empty-state")).toContainText(
    "No groups in this view",
  );
});

test("track replacement and semantic revisions discard unapplied drafts but retain saved stale reasoning", async ({
  page,
  appUrl,
}) => {
  await page.goto(appUrl);
  await importPair(page, "Ownership");
  await editor(page)
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Committed reasoning");
  await acceptKey(page);
  for (const role of ["source", "translation"] as const) {
    await editor(page)
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("Unapplied old material");
    await page.getByLabel(`Replace ${role}`, { exact: true }).setInputFiles({
      name: `new-${role}.srt`,
      mimeType: "text/plain",
      buffer: pair(`Replacement ${role}`),
    });
    await expect(page.locator(".announcement")).toContainText("Track replaced");
    await expect(
      editor(page).getByRole("textbox", { name: "Comment", exact: true }),
    ).toHaveValue("Committed reasoning");
    await expect(editor(page).locator(".state-tag")).toHaveText("stale");
  }
  await editor(page)
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Unapplied preset draft");
  await page.getByRole("button", { name: "Rule preset", exact: true }).click();
  await page.getByLabel("Maximum CPS", { exact: true }).fill("20");
  await page.getByRole("button", { name: "Apply preset", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    editor(page).getByRole("textbox", { name: "Comment", exact: true }),
  ).toHaveValue("Committed reasoning");
  await editor(page)
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Unapplied navigation draft");
  await page
    .getByRole("button", { name: "Next in queue", exact: true })
    .click();
  await expect(
    editor(page).getByRole("textbox", { name: "Comment", exact: true }),
  ).toHaveValue("");
  await page.keyboard.press("k");
  await expect(
    editor(page).getByRole("textbox", { name: "Comment", exact: true }),
  ).toHaveValue("Committed reasoning");
  const pkg = await exported(page);
  expect(
    pkg.session.decisions.every((d) => !d.comment.includes("Unapplied")),
  ).toBe(true);
});

test("real worker Undo survives cancel, late results, new edits and worker error before retry", async ({
  page,
  appUrl,
}, info) => {
  await installWorkerGate(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(appUrl);
  await importPair(page, "Undo");
  await correct(page, "First correction.");
  await page.evaluate(() => {
    window.reviewGate.mode = "hold";
  });
  await page
    .getByRole("button", { name: "Undo edit (1)", exact: true })
    .click();
  await page.waitForFunction(() => window.reviewGate.waiting);
  await page
    .getByRole("button", { name: "Cancel calculation", exact: true })
    .click();
  await expect(page.locator(".bilingual-columns")).toContainText(
    "First correction.",
  );
  await expect(
    page.getByRole("button", { name: "Undo edit (1)", exact: true }),
  ).toBeEnabled();
  await correct(page, "Second correction.");
  await page.evaluate(() => window.reviewGate.release?.());
  await expect(
    page.getByRole("button", { name: "Undo edit (2)", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Undo edit (2)", exact: true })
    .click();
  await expect(page.locator(".bilingual-columns")).toContainText(
    "First correction.",
  );
  await page
    .getByRole("button", { name: "Undo edit (1)", exact: true })
    .click();
  await expect(page.locator(".bilingual-columns")).toContainText(
    "Undo translation cue 1.",
  );
  await correct(page, "Correction before worker error.");
  await page.evaluate(() => {
    window.reviewGate.mode = "error";
  });
  await page
    .getByRole("button", { name: "Undo edit (1)", exact: true })
    .click();
  await expect(page.locator(".announcement")).toContainText(
    "Synthetic worker failure",
  );
  await expect(
    page.getByRole("button", { name: "Undo edit (1)", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Undo edit (1)", exact: true })
    .click();
  await expect(page.locator(".bilingual-columns")).toContainText(
    "Undo translation cue 1.",
  );
  await expect(
    page.getByRole("button", { name: "Undo edit (0)", exact: true }),
  ).toBeDisabled();
  const restored = await exported(page);
  expect(restored.session.edits).toEqual([]);
  expect(
    restored.session.history.filter((h) =>
      h.action.startsWith("Undo restored"),
    ),
  ).toHaveLength(3);
  await capture(page, "restored-undo", info.project.name);
  expect(errors).toEqual([]);
});

test("nested cue and finding pages remain bounded after a semantic revision", async ({
  page,
  appUrl,
}) => {
  await page.goto(appUrl);
  const dense = Buffer.from(
    Array.from(
      { length: 60 },
      (_, i) =>
        `${i + 1}\n00:00:01,000 --> 00:00:03,000\n${"Dense text ".repeat(40)} ${i}\n\n`,
    ).join(""),
  );
  for (const [label, name] of [
    ["Source subtitles", "source.srt"],
    ["Translated subtitles", "translation.srt"],
  ])
    await page
      .getByLabel(label, { exact: true })
      .setInputFiles({ name, mimeType: "text/plain", buffer: dense });
  await page.getByRole("button", { name: "Start review", exact: true }).click();
  await expect(page.locator(".cue-block")).toHaveCount(100);
  for (const track of await page.locator(".bilingual-columns > section").all())
    await track.getByRole("button", { name: "Next cues", exact: true }).click();
  await expect(page.locator(".cue-block")).toHaveCount(20);
  const next = page.getByRole("button", { name: "Next findings", exact: true });
  while (await next.isEnabled()) await next.click();
  await page.getByRole("button", { name: "Rule preset", exact: true }).click();
  await page.getByLabel("Maximum CPS", { exact: true }).fill("1000");
  await page.getByRole("button", { name: "Apply preset", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".cue-block")).toHaveCount(100);
  await expect(page.locator(".finding-button")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Previous findings", exact: true }),
  ).toHaveCount(0);
});

test("normal, long, RTL and session replacement layouts keep keyboard dialogs usable at 1440 and 390", async ({
  page,
  appUrl,
}, info) => {
  const errors: string[] = [],
    external: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith(appUrl) || r.method() !== "GET")
      external.push(`${r.method()} ${r.url()}`);
  });
  await page.goto(appUrl);
  await importPair(page, "Normal");
  await capture(page, "normal", info.project.name);
  await importPair(page, "LongWord".repeat(250));
  await capture(page, "long", info.project.name);
  await importPair(page, "مرحبا بكم · שלום לכולם · 欢迎朋友");
  await capture(page, "rtl", info.project.name);
  await editor(page)
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Old material draft");
  await importPair(page, "Replacement");
  await expect(
    editor(page).getByRole("textbox", { name: "Comment", exact: true }),
  ).toHaveValue("");
  await capture(page, "session-replacement", info.project.name);
  await page
    .getByRole("button", { name: "Edit translation cue 1", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Close editor", exact: true }),
  ).toBeFocused();
  await dialog
    .getByRole("button", { name: "Preview change", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close editor", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Preview change", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
