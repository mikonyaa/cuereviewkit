import {
  LIMITS,
  type Cue,
  type Edge,
  type Group,
  type Mapping,
  type Alignment,
} from "../review/types";

export const overlap = (a: Cue, b: Cue) =>
  a.endMs > a.startMs && b.endMs > b.startMs
    ? Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs))
    : 0;
export function unionCoverage(cue: Cue, counterparts: Cue[]): number {
  if (cue.endMs <= cue.startMs) return 0;
  const intervals = counterparts
    .filter((t) => overlap(cue, t) > 0)
    .map((t) => [
      Math.max(cue.startMs, t.startMs),
      Math.min(cue.endMs, t.endMs),
    ])
    .sort((a, b) => a[0] - b[0]);
  let end = -1,
    total = 0;
  for (const [a, b] of intervals) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}
export function validateMapping(
  mapping: Mapping[],
  source: Cue[],
  target: Cue[],
): void {
  const s = new Set(source.map((c) => c.id)),
    t = new Set(target.map((c) => c.id));
  const seenS = new Set<string>(),
    seenT = new Set<string>();
  if (mapping.length > s.size + t.size)
    throw new Error("Too many mapping groups.");
  for (const group of mapping) {
    if (!group.source.length && !group.translation.length)
      throw new Error("Empty mapping group.");
    for (const id of group.source) {
      if (!s.has(id) || seenS.has(id))
        throw new Error("Mapping has an unknown or duplicated source cue.");
      seenS.add(id);
    }
    for (const id of group.translation) {
      if (!t.has(id) || seenT.has(id))
        throw new Error(
          "Mapping has an unknown or duplicated translation cue.",
        );
      seenT.add(id);
    }
  }
  if (s.size !== seenS.size || t.size !== seenT.size)
    throw new Error("Mapping must account for every cue exactly once.");
}
function groupFor(
  mapping: Mapping,
  cueById: Map<string, Cue>,
  edges: Edge[],
  ambiguous = false,
  nearCandidates: string[] = [],
): Group {
  const source = [...mapping.source].sort(
      (a, b) => cueById.get(a)!.ordinal - cueById.get(b)!.ordinal,
    ),
    translation = [...mapping.translation].sort(
      (a, b) => cueById.get(a)!.ordinal - cueById.get(b)!.ordinal,
    );
  const cues = [...source, ...translation].map((id) => cueById.get(id)!);
  const startMs = Math.min(...cues.map((c) => c.startMs)),
    endMs = Math.max(...cues.map((c) => c.endMs));
  return {
    ...mapping,
    source,
    translation,
    id: `g:${source.map((id) => "s" + cueById.get(id)!.ordinal).join(".")}:${translation.map((id) => "t" + cueById.get(id)!.ordinal).join(".")}`,
    type:
      !source.length || !translation.length
        ? "unmatched"
        : source.length === 1
          ? translation.length === 1
            ? "1:1"
            : "1:n"
          : translation.length === 1
            ? "n:1"
            : "n:m",
    startMs,
    endMs,
    requiresManual:
      source.length > 8 || translation.length > 8 || endMs - startMs > 30_000,
    ambiguous,
    nearCandidates,
    edges,
  };
}
export function align(
  source: Cue[],
  target: Cue[],
  toleranceMs = 200,
  manual: Mapping[] | null = null,
  edgeLimit: number = LIMITS.edges,
): Alignment {
  const all = [...source, ...target],
    cueById = new Map(all.map((c) => [c.id, c]));
  const parent = all.map((_, i) => i),
    rank = all.map(() => 0),
    indices = new Map(all.map((c, i) => [c.id, i]));
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const join = (a: number, b: number) => {
    a = find(a);
    b = find(b);
    if (a === b) return;
    if (rank[a] < rank[b]) [a, b] = [b, a];
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a]++;
  };
  const events = all
    .flatMap((c, index) =>
      c.endMs > c.startMs
        ? [
            { at: c.startMs, start: true, index },
            { at: c.endMs, start: false, index },
          ]
        : [],
    )
    .sort(
      (a, b) =>
        a.at - b.at || Number(a.start) - Number(b.start) || a.index - b.index,
    );
  const activeS = new Map<number, Cue>(),
    activeT = new Map<number, Cue>(),
    edges: Edge[] = [];
  let incomplete = false,
    reason: string | undefined;
  for (const event of events) {
    const cue = all[event.index],
      isSource = event.index < source.length,
      own = isSource ? activeS : activeT,
      other = isSource ? activeT : activeS;
    if (!event.start) {
      own.delete(event.index);
      continue;
    }
    for (const [index, counterpart] of other) {
      if (edges.length >= edgeLimit) {
        incomplete = true;
        reason = `Alignment stopped at ${edgeLimit.toLocaleString("en")} edges; coverage and findings are incomplete.`;
        break;
      }
      edges.push({
        source: isSource ? cue.id : counterpart.id,
        translation: isSource ? counterpart.id : cue.id,
        overlapMs: overlap(cue, counterpart),
      });
      join(event.index, index);
    }
    if (incomplete) break;
    own.set(event.index, cue);
  }
  const touched = new Set(edges.flatMap((e) => [e.source, e.translation]));
  const near = new Map<string, { score: number; ids: string[] }>();
  if (!incomplete && !manual && toleranceMs > 0) {
    const ss = source
      .filter((c) => !touched.has(c.id) && c.endMs > c.startMs)
      .sort((a, b) => a.startMs - b.startMs || a.ordinal - b.ordinal);
    const tt = target
      .filter((c) => !touched.has(c.id) && c.endMs > c.startMs)
      .sort((a, b) => a.startMs - b.startMs || a.ordinal - b.ordinal);
    let low = 0,
      attempts = 0;
    const consider = (a: Cue, b: Cue, score: number) => {
      const old = near.get(a.id);
      if (!old || score < old.score) near.set(a.id, { score, ids: [b.id] });
      else if (score === old.score) old.ids.push(b.id);
    };
    outer: for (const s of ss) {
      while (low < tt.length && tt[low].startMs < s.startMs - toleranceMs)
        low++;
      for (
        let j = low;
        j < tt.length && tt[j].startMs <= s.startMs + toleranceMs;
        j++
      ) {
        if (++attempts > edgeLimit) {
          incomplete = true;
          reason = "Near-candidate limit reached; alignment is incomplete.";
          break outer;
        }
        const t = tt[j],
          distance = Math.max(
            Math.abs(s.startMs - t.startMs),
            Math.abs(s.endMs - t.endMs),
          );
        if (distance <= toleranceMs) {
          consider(s, t, distance);
          consider(t, s, distance);
        }
      }
    }
    if (!incomplete)
      for (const s of ss) {
        const candidate = near.get(s.id);
        if (candidate?.ids.length !== 1) continue;
        const tId = candidate.ids[0],
          back = near.get(tId);
        if (back?.ids.length === 1 && back.ids[0] === s.id)
          join(indices.get(s.id)!, indices.get(tId)!);
      }
  }
  let mapping: Mapping[];
  if (manual) {
    validateMapping(manual, source, target);
    mapping = manual;
  } else {
    const components = new Map<number, Mapping>();
    all.forEach((c, i) => {
      const key = find(i);
      let m = components.get(key);
      if (!m) {
        m = { source: [], translation: [], provenance: "automatic-overlap" };
        components.set(key, m);
      }
      (i < source.length ? m.source : m.translation).push(c.id);
    });
    mapping = [...components.values()].map((m) => ({
      ...m,
      provenance:
        m.source.length && m.translation.length && !touched.has(m.source[0])
          ? "automatic-near"
          : "automatic-overlap",
    }));
  }
  const groupIndex = new Map<string, number>();
  mapping.forEach((m, i) =>
    [...m.source, ...m.translation].forEach((id) => groupIndex.set(id, i)),
  );
  const groupEdges: Edge[][] = mapping.map(() => []);
  for (const e of edges)
    if (groupIndex.get(e.source) === groupIndex.get(e.translation))
      groupEdges[groupIndex.get(e.source)!].push(e);
  const groups = mapping
    .map((m, i) => {
      const candidates = [...m.source, ...m.translation]
        .flatMap((id) => near.get(id)?.ids ?? [])
        .filter((id) => !m.source.includes(id) && !m.translation.includes(id));
      return groupFor(
        m,
        cueById,
        groupEdges[i],
        !manual && candidates.length > 0,
        [...new Set(candidates)].slice(0, 16),
      );
    })
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  return { groups, incomplete, reason, edgeCount: edges.length };
}
export function splitGroup(mapping: Mapping[], index: number): Mapping[] {
  const group = mapping[index];
  if (!group) throw new Error("Unknown group.");
  const replacement = [
    ...group.source.map((id) => ({
      source: [id],
      translation: [],
      provenance: "manual" as const,
    })),
    ...group.translation.map((id) => ({
      source: [],
      translation: [id],
      provenance: "manual" as const,
    })),
  ];
  return mapping.flatMap((g, i) =>
    i === index ? replacement : [{ ...g, provenance: "manual" as const }],
  );
}
export function mergeGroups(mapping: Mapping[], selected: number[]): Mapping[] {
  const set = new Set(selected);
  if (set.size < 2 || selected.some((i) => !mapping[i]))
    throw new Error("Select at least two existing groups.");
  const merged: Mapping = { source: [], translation: [], provenance: "manual" };
  selected.forEach((i) => {
    merged.source.push(...mapping[i].source);
    merged.translation.push(...mapping[i].translation);
  });
  return [
    ...mapping
      .filter((_, i) => !set.has(i))
      .map((g) => ({ ...g, provenance: "manual" as const })),
    merged,
  ];
}
