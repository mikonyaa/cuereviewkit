import { mkdir, writeFile } from "node:fs/promises";
import { formatTime } from "../src/formats/time";
import { parseDocument } from "../src/formats/source-document";
import { createSession, addDecision } from "../src/review/engine";
import { exportPackage } from "../src/package";
import { renderReport } from "../src/package/report";
type Row = { start: number; end: number; text: string; n?: number };
const encode = (rows: Row[], nl = "\n", bom = false) =>
  (bom ? "\uFEFF" : "") +
  rows
    .map(
      (r, i) =>
        `${r.n ?? i + 1}${nl}${formatTime(r.start)} --> ${formatTime(r.end)}${nl}${r.text.replace(/\n/g, nl)}${nl}${nl}`,
    )
    .join("");
const generated = (count: number, language: "en" | "ru"): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    start: 1_000 + i * 3_000,
    end: 3_500 + i * 3_000,
    text:
      language === "en"
        ? [
            "The tram leaves from the square.",
            "Please keep the aisle clear.",
            "The next stop is the riverside.",
            "Our guide will meet us there.",
            "Bring your ticket to the entrance.",
            "The doors close after the signal.",
          ][i % 6]
        : [
            "Трамвай отправляется с площади.",
            "Пожалуйста, оставьте проход свободным.",
            "Следующая остановка — набережная.",
            "Наш гид встретит нас там.",
            "Принесите билет ко входу.",
            "Двери закрываются после сигнала.",
          ][i % 6],
  }));
await mkdir("fixtures/corpus", { recursive: true });
const source = generated(240, "en"),
  target = generated(240, "ru");
source[20].text = "Please bring 100 tickets.";
target[20].text = "Принесите 1000 билетов.";
const merge = {
  ...target[4],
  end: target[5].end,
  text: target[4].text + " " + target[5].text,
};
const splitA = {
    ...target[8],
    end: target[8].start + 1_000,
    text: "Следующая остановка —",
  },
  splitB = {
    ...target[8],
    start: target[8].start + 1_000,
    text: "набережная.",
  };
const demoTarget = target.flatMap((r, i) =>
  i === 5 || i === 12
    ? []
    : i === 4
      ? [merge]
      : i === 8
        ? [splitA, splitB]
        : [r],
);
if (demoTarget.length !== 239) throw new Error("Demo arithmetic mismatch");
const expected = {
  sourceCount: 240,
  translationCount: 239,
  merge: { sourceOrdinals: [4, 5], translationOrdinals: [4] },
  split: { sourceOrdinals: [8], translationOrdinals: [7, 8] },
  unmatchedSourceOrdinals: [12],
  numericDifference: {
    sourceOrdinal: 20,
    sourceTokens: ["100"],
    translationTokens: ["1000"],
  },
  synthetic: true,
};
await writeFile("examples/source.srt", encode(source));
await writeFile("examples/translation.srt", encode(demoTarget));
await writeFile(
  "examples/expected.json",
  JSON.stringify(expected, null, 2) + "\n",
);
for (const name of ["source.srt", "translation.srt", "expected.json"]) {
  const { readFile } = await import("node:fs/promises");
  await writeFile(
    "public/examples/" + name,
    await readFile("examples/" + name),
  );
}
const smallS: Row[] = [
  { start: 1000, end: 2000, text: "Take the tram." },
  { start: 2000, end: 3000, text: "Bring 100 tickets." },
  { start: 5000, end: 6000, text: "Meet at the entrance." },
];
const smallT: Row[] = [
  {
    start: 1000,
    end: 3000,
    text: "Садись в трамвай. Возьми 1000 билетов.",
    n: 90,
  },
];
await writeFile("fixtures/feasibility-source.srt", encode(smallS));
await writeFile("fixtures/feasibility-translation.srt", encode(smallT));
await writeFile(
  "fixtures/feasibility-expected.json",
  JSON.stringify(
    {
      groups: [
        { type: "n:1", sourceOrdinals: [0, 1], translationOrdinals: [0] },
        { type: "unmatched", sourceOrdinals: [2], translationOrdinals: [] },
      ],
      rules: ["number-difference", "uncovered-interval"],
    },
    null,
    2,
  ) + "\n",
);
const corpusManifest = [];
for (let c = 0; c < 10; c++) {
  const a = generated(c === 0 ? 240 : 140, "en"),
    b = generated(c === 0 ? 140 : 140, "ru");
  const expectation: Record<string, unknown> = {
    sourceCount: a.length,
    translationCount: b.length,
    grouping: "all 1:1 for shared intervals; extra source intervals unmatched",
    unmatchedSourceCount: c === 0 ? 100 : 0,
  };
  if (c === 1) {
    a[0].text = "你好 世界";
    b[0].text = "欢迎\n朋友";
    expectation.graphemesSource0 = 5;
  }
  if (c === 2) {
    a[1].text = "مرحبا بكم";
    b[1].text = "שלום לכולם";
  }
  if (c === 3) {
    b[3].end = b[3].start;
    expectation.invalidTranslationOrdinal = 3;
  }
  if (c === 4) {
    b[4].end = b[4].start - 1;
    expectation.invalidTranslationOrdinal = 4;
  }
  if (c === 5) {
    b[5].text = "x".repeat(2_000);
    expectation.fastTranslationOrdinal = 5;
  }
  if (c === 6) {
    a[6].text = "It costs 1,000.";
    b[6].text = "Цена 1.000.";
    expectation.numberUncertaintyOrdinal = 6;
  }
  if (c === 7) {
    b[7].end = b[7].start + 100;
    expectation.shortOrdinal = 7;
  }
  if (c === 8) {
    a[8].text = "<b>Keep</b> <i>this</i>.";
    b[8].text = "<b>Оставь</b> <i>это</i>.";
  }
  if (c === 9) {
    b[9].start += 500;
    expectation.partialOrdinal = 9;
  }
  const prefix = `case-${String(c + 1).padStart(2, "0")}`;
  await writeFile(
    `fixtures/corpus/${prefix}-source.srt`,
    encode(a, c % 2 ? "\r\n" : "\n", c === 8),
  );
  await writeFile(
    `fixtures/corpus/${prefix}-translation.srt`,
    encode(b, c % 2 ? "\r\n" : "\n", c === 8),
  );
  corpusManifest.push({ prefix, ...expectation });
}
await writeFile(
  "fixtures/corpus/expected.json",
  JSON.stringify(corpusManifest, null, 2) + "\n",
);
const enc = new TextEncoder();
let review = await createSession(
  await parseDocument(enc.encode(encode(source)), "source.srt", "source"),
  await parseDocument(
    enc.encode(encode(demoTarget)),
    "translation.srt",
    "translation",
  ),
);
const group = review.analysis.alignment.groups.find((g) => g.type === "n:1")!;
review = addDecision(
  review,
  group.id,
  "accepted",
  "The two adjacent source cues are intentionally merged into one translated cue.",
  "Sample editor",
);
await writeFile("examples/sample.cue-review.zip", await exportPackage(review));
await writeFile("examples/report.html", renderReport(review));
for (const name of ["sample.cue-review.zip", "report.html"]) {
  const { readFile } = await import("node:fs/promises");
  await writeFile(
    "public/examples/" + name,
    await readFile("examples/" + name),
  );
}
console.log(
  "Created own synthetic 240/239 demo, 10 corpus pairs (1,500 source + 1,400 target cues), sample report/package.",
);
