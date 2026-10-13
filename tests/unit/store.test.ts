import { afterEach, expect, it, vi } from "vitest";
import { ReviewStore } from "../../src/ui/store";
import { analyze, createSession, decisionFor } from "../../src/review/engine";
import {
  parseDocument,
  serializeCorrected,
} from "../../src/formats/source-document";
import { exportPackage, importPackage } from "../../src/package";
import type { Analysis, ReviewInput } from "../../src/review/types";
import type { Payloads } from "../../src/workers/protocol";

afterEach(() => vi.restoreAllMocks());
const subtitle = (text: string) =>
  new File([`1\n00:00:01,000 --> 00:00:03,000\n${text}\n\n`], "own.srt");

async function setup() {
  const store = new ReviewStore();
  let nextAnalysis: ((input: ReviewInput) => Promise<Analysis>) | undefined;
  // Control scheduling only. Parsing, analysis and serialization remain real.
  vi.spyOn(store.client, "run").mockImplementation(async (kind, payload) => {
    if (kind === "pair") {
      const p = payload as Payloads["pair"];
      return (await createSession(
        await parseDocument(p.source.bytes, p.source.filename, "source"),
        await parseDocument(
          p.translation.bytes,
          p.translation.filename,
          "translation",
        ),
      )) as never;
    }
    if (kind === "analyze") {
      const hold = nextAnalysis;
      nextAnalysis = undefined;
      return (await (hold ?? analyze)(payload as ReviewInput)) as never;
    }
    if (kind === "corrected") {
      const p = payload as Payloads["corrected"];
      return (await serializeCorrected(p.document, p.edits)) as never;
    }
    throw new Error(`Unexpected test operation ${kind}`);
  });
  await store.importPair(subtitle("A source."), subtitle("A translation."));
  const original = store.getSnapshot().session!;
  const cue = original.translation.cues[0];
  await store.edit(cue.id, cue.startMs, cue.endMs, "First correction.");
  return {
    store,
    cue,
    original,
    defer() {
      let resolve!: (value: Analysis) => void;
      let reject!: (reason: Error) => void;
      let input!: ReviewInput;
      nextAnalysis = (value) => {
        input = value;
        return new Promise<Analysis>((yes, no) => {
          resolve = yes;
          reject = no;
        });
      };
      return {
        release: async () => resolve(await analyze(input)),
        reject: () => reject(new Error("Synthetic worker failure")),
      };
    },
  };
}

it("ordinary Undo restores the data revision and consumes one snapshot", async () => {
  const { store, original } = await setup();
  expect(store.getSnapshot().undoCount).toBe(1);
  await store.undoEdit();
  expect(store.getSnapshot().session!.analysis.revision).toBe(
    original.analysis.revision,
  );
  expect(store.getSnapshot().session!.analysis.working[0].text).toBe(
    "A translation.",
  );
  expect(store.getSnapshot().undoCount).toBe(0);
});

it("cancelled Undo keeps the snapshot and a retry restores the original", async () => {
  const h = await setup();
  const delay = h.defer();
  const pending = h.store.undoEdit();
  h.store.cancel();
  await delay.release();
  await pending;
  expect(h.store.getSnapshot().session!.analysis.working[0].text).toBe(
    "First correction.",
  );
  expect(h.store.getSnapshot().undoCount).toBe(1);
  await h.store.undoEdit();
  expect(h.store.getSnapshot().session!.analysis.revision).toBe(
    h.original.analysis.revision,
  );
  expect(h.store.getSnapshot().undoCount).toBe(0);
});

it("rejected Undo keeps the snapshot for retry", async () => {
  const h = await setup();
  const delay = h.defer();
  const pending = h.store.undoEdit();
  delay.reject();
  await pending;
  expect(h.store.getSnapshot().error).toBe("Synthetic worker failure");
  expect(h.store.getSnapshot().undoCount).toBe(1);
  await h.store.undoEdit();
  expect(h.store.getSnapshot().session!.analysis.working[0].text).toBe(
    "A translation.",
  );
  expect(h.store.getSnapshot().undoCount).toBe(0);
});

it("a late Undo result cannot consume a new edit's snapshot after cancellation", async () => {
  const h = await setup();
  const delay = h.defer();
  const pending = h.store.undoEdit();
  h.store.cancel();
  await h.store.edit(h.cue.id, 1000, 3000, "Second correction.");
  await delay.release();
  await pending;
  expect(h.store.getSnapshot().undoCount).toBe(2);
  await h.store.undoEdit();
  expect(h.store.getSnapshot().session!.analysis.working[0].text).toBe(
    "First correction.",
  );
  expect(h.store.getSnapshot().undoCount).toBe(1);
  await h.store.undoEdit();
  expect(h.store.getSnapshot().session!.analysis.working[0].text).toBe(
    "A translation.",
  );
});

it("a late Undo result cannot replace an imported pair or consume its history", async () => {
  const h = await setup();
  const delay = h.defer();
  const pending = h.store.undoEdit();
  h.store.cancel();
  await h.store.importPair(subtitle("B source."), subtitle("B translation."));
  await h.store.edit(
    h.store.getSnapshot().session!.translation.cues[0].id,
    1000,
    3000,
    "B correction.",
  );
  await delay.release();
  await pending;
  expect(h.store.getSnapshot().undoCount).toBe(1);
  await h.store.undoEdit();
  expect(h.store.getSnapshot().session!.analysis.working[0].text).toBe(
    "B translation.",
  );
});

it("omitted decision fields preserve recorded reasoning while explicit empty fields clear it", async () => {
  const { store } = await setup();
  const subject = store.getSnapshot().session!.analysis.alignment.groups[0].id;
  store.decide(subject, "accepted", "Editorial reasoning A", "Reviewer A");
  // Omitted values mean keep the latest saved values, including stale reasoning.
  store.decide(subject, "needs-change");
  expect(store.getSnapshot().error).toBe("");
  const reopened = await importPackage(
    await exportPackage(store.getSnapshot().session!),
  );
  expect(decisionFor(reopened.session, subject)?.comment).toBe(
    "Editorial reasoning A",
  );
  expect(decisionFor(reopened.session, subject)?.reviewer).toBe("Reviewer A");
  expect(decisionFor(reopened.session, subject)?.status).toBe("needs-change");
  store.decide(subject, "accepted", "", "");
  const cleared = await importPackage(
    await exportPackage(store.getSnapshot().session!),
  );
  expect(decisionFor(cleared.session, subject)?.comment).toBe("");
  expect(decisionFor(cleared.session, subject)?.reviewer).toBe("");
});

it("Undo retains only 30 successful data snapshots and the journal stays bounded", async () => {
  const { store, cue } = await setup();
  for (let i = 2; i <= 35; i++)
    await store.edit(cue.id, 1000, 3000, `Correction ${i}.`);
  const subject = store.getSnapshot().session!.analysis.alignment.groups[0].id;
  for (let i = 0; i < 210; i++)
    store.decide(subject, "accepted", `Decision ${i}`, "");
  expect(store.getSnapshot().undoCount).toBe(30);
  expect(store.getSnapshot().session!.history).toHaveLength(200);
  for (let i = 0; i < 30; i++) await store.undoEdit();
  expect(store.getSnapshot().undoCount).toBe(0);
  expect(store.getSnapshot().session!.analysis.working[0].text).toBe(
    "Correction 5.",
  );
  expect(store.getSnapshot().session!.history).toHaveLength(200);
});

it("warning waiver stays separate from translation acceptance and needs-change retains explicit reasoning", async () => {
  const { store } = await setup();
  await store.importPair(subtitle("Fee: 100."), subtitle("Fee: 1000."));
  const session = store.getSnapshot().session!;
  const warning = session.analysis.findings.find((f) =>
    f.ruleId.startsWith("number-"),
  )!.id;
  const group = session.analysis.alignment.groups[0].id;
  store.decide(warning, "waived", "Checked the intended figure", "Editor");
  store.decide(group, "accepted", "Group reasoning", "Editor");
  expect(decisionFor(store.getSnapshot().session!, warning)?.status).toBe(
    "waived",
  );
  store.decide(warning, "accepted");
  expect(store.getSnapshot().error).toContain("separately");
  expect(decisionFor(store.getSnapshot().session!, warning)?.status).toBe(
    "waived",
  );
  store.decide(group, "needs-change", "Correct the figure");
  expect(decisionFor(store.getSnapshot().session!, group)?.comment).toBe(
    "Correct the figure",
  );
  expect(decisionFor(store.getSnapshot().session!, group)?.reviewer).toBe(
    "Editor",
  );
});
