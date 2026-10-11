import {
  RULE_VERSION,
  type Cue,
  type Config,
  type Finding,
  type Alignment,
  type Role,
} from "../review/types";
import { unionCoverage } from "../alignment";
import { graphemeCount } from "../formats/markup";
import { displayTime } from "../formats/time";
export function numberTokens(text: string): {
  raw: string[];
  uncertain: boolean;
} {
  const raw =
    text.match(/\p{Nd}+(?:[.,\u066b\u066c\u00a0\u202f ]\p{Nd}+)*/gu) ?? [];
  return { raw, uncertain: raw.some((t) => /[^0-9]/.test(t)) };
}
export function runRules(
  source: Cue[],
  translation: Cue[],
  alignment: Alignment,
  config: Config,
): Finding[] {
  const findings: Finding[] = [],
    sMap = new Map(source.map((c) => [c.id, c])),
    tMap = new Map(translation.map((c) => [c.id, c]));
  const emit = (
    ruleId: string,
    role: Role | undefined,
    cueIds: string[],
    evidence: string,
    explanation: string,
    groupId?: string,
    severity: "error" | "warning" = "warning",
  ) =>
    findings.push({
      id: `f:${ruleId}:${role ?? "pair"}:${groupId ?? cueIds.join("|")}`,
      ruleId,
      ruleVersion: RULE_VERSION,
      severity,
      category: severity === "error" ? "structural" : "configurable",
      scope: { role, cueIds, groupId },
      evidence,
      explanation,
      config: { ...config },
    });
  for (const [role, track] of [
    ["source", source],
    ["translation", translation],
  ] as const) {
    for (const cue of track) {
      const duration = cue.endMs - cue.startMs;
      if (duration <= 0)
        emit(
          "invalid-interval",
          role,
          [cue.id],
          `${displayTime(cue.startMs)} → ${displayTime(cue.endMs)} (${duration} ms)`,
          "End must be after start. Zero/reversed intervals have no temporal overlap; CPS is not computable.",
          undefined,
          "error",
        );
      else if (duration < config.minDurationMs)
        emit(
          "short-duration",
          role,
          [cue.id],
          `${duration} ms < ${config.minDurationMs} ms`,
          "Project duration preset; review in context.",
        );
      else if (duration > config.maxDurationMs)
        emit(
          "long-duration",
          role,
          [cue.id],
          `${duration} ms > ${config.maxDurationMs} ms`,
          "Project duration preset; a long cue may be intentional.",
        );
      if (!cue.text.trim())
        emit(
          "empty-text",
          role,
          [cue.id],
          "Empty payload",
          "Check whether the empty subtitle is intentional.",
        );
      const count = graphemeCount(cue.text, config.locale);
      if (count === null)
        emit(
          "cps-not-computable",
          role,
          [cue.id],
          "Unknown markup or unavailable Intl.Segmenter",
          "CPS is not computed from unsupported text.",
        );
      else if (duration > 0 && count / (duration / 1_000) > config.maxCps)
        emit(
          "reading-speed",
          role,
          [cue.id],
          `${(count / (duration / 1_000)).toFixed(1)} CPS; ${count} graphemes / ${(duration / 1_000).toFixed(3)} s`,
          `Project preset > ${config.maxCps} CPS. Includes spaces; excludes line breaks and recognized b/i/u tags. This is not a universal language standard.`,
        );
    }
    // Connected overlapping runs produce one finding per run, avoiding quadratic pairs.
    const sorted = track
      .filter((c) => c.endMs > c.startMs)
      .sort((a, b) => a.startMs - b.startMs || a.ordinal - b.ordinal);
    let run: Cue[] = [],
      end = -1;
    const flush = () => {
      if (run.length > 1)
        emit(
          "track-overlap",
          role,
          run.map((c) => c.id),
          `${run.length} cues in an overlapping run: ${displayTime(run[0].startMs)}–${displayTime(end)}`,
          "Overlapping speakers may be intentional. This warning requests a human check.",
        );
    };
    for (const cue of sorted) {
      if (cue.startMs >= end) {
        flush();
        run = [];
        end = -1;
      }
      run.push(cue);
      end = Math.max(end, cue.endMs);
    }
    flush();
  }
  for (const group of alignment.incomplete ? [] : alignment.groups) {
    const ss = group.source.map((id) => sMap.get(id)!),
      tt = group.translation.map((id) => tMap.get(id)!);
    const counterparts = new Map<string, Cue[]>();
    for (const edge of group.edges) {
      if (!counterparts.has(edge.source)) counterparts.set(edge.source, []);
      if (!counterparts.has(edge.translation))
        counterparts.set(edge.translation, []);
      counterparts.get(edge.source)!.push(tMap.get(edge.translation)!);
      counterparts.get(edge.translation)!.push(sMap.get(edge.source)!);
    }
    for (const [role, track] of [
      ["source", ss],
      ["translation", tt],
    ] as const)
      for (const cue of track) {
        const duration = cue.endMs - cue.startMs,
          covered = unionCoverage(cue, counterparts.get(cue.id) ?? []);
        if (duration <= 0) continue;
        if (!covered)
          emit(
            "uncovered-interval",
            role,
            [cue.id],
            `0 / ${duration} ms covered`,
            "No real temporal coverage. This does not prove a semantic omission; near matching adds no coverage.",
            group.id,
          );
        else if (covered / duration < config.minCoverage)
          emit(
            "partial-coverage",
            role,
            [cue.id],
            `${covered} / ${duration} ms (${((100 * covered) / duration).toFixed(1)}%) covered`,
            "Coverage uses the union of actual intersections, without double counting overlaps.",
            group.id,
          );
      }
    if (ss.length && tt.length) {
      const a = numberTokens(ss.map((c) => c.text).join("\n")),
        b = numberTokens(tt.map((c) => c.text).join("\n"));
      if (a.raw.length || b.raw.length) {
        const different =
          JSON.stringify([...a.raw].sort()) !==
          JSON.stringify([...b.raw].sort());
        if (different || a.uncertain || b.uncertain)
          emit(
            a.uncertain || b.uncertain
              ? "number-uncertainty"
              : "number-difference",
            undefined,
            [...group.source, ...group.translation],
            `Source: ${a.raw.join(" | ") || "none"} → translation: ${b.raw.join(" | ") || "none"}; policy: raw Unicode decimal tokens, no normalization`,
            "Separators and localized digits require human interpretation. No automatic correction; words, units, dates and semantic equivalence are outside this rule.",
            group.id,
          );
      }
    }
  }
  return findings;
}
