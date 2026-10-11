import { VERSION, type Session } from "../review/types";
import { isDecisionCurrent, decisionFor } from "../review/engine";
import { displayTime } from "../formats/time";
import { unionCoverage } from "../alignment";
export const escapeHtml = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function renderReport(session: Session): string {
  const h = escapeHtml,
    analysis = session.analysis;
  const source = new Map(session.source.cues.map((c) => [c.id, c])),
    target = new Map(analysis.working.map((c) => [c.id, c]));
  const groupForCue = new Map<string, string>();
  analysis.alignment.groups.forEach((g) =>
    [...g.source, ...g.translation].forEach((id) => groupForCue.set(id, g.id)),
  );
  const findingsByGroup = new Map<string, typeof analysis.findings>();
  for (const f of analysis.findings)
    for (const gid of new Set(
      f.scope.groupId
        ? [f.scope.groupId]
        : f.scope.cueIds
            .map((id) => groupForCue.get(id))
            .filter((id): id is string => !!id),
    )) {
      if (!findingsByGroup.has(gid)) findingsByGroup.set(gid, []);
      findingsByGroup.get(gid)!.push(f);
    }
  const status = (subject: string) => {
    const d = decisionFor(session, subject);
    return !d
      ? "unresolved"
      : isDecisionCurrent(d, analysis)
        ? d.status
        : `stale (previously ${d.status})`;
  };
  const coverage = new Map<string, number>();
  for (const g of analysis.alignment.groups) {
    const pairs = new Map<string, typeof session.source.cues>();
    for (const edge of g.edges) {
      if (!pairs.has(edge.source)) pairs.set(edge.source, []);
      if (!pairs.has(edge.translation)) pairs.set(edge.translation, []);
      pairs.get(edge.source)!.push(target.get(edge.translation)!);
      pairs.get(edge.translation)!.push(source.get(edge.source)!);
    }
    for (const id of [...g.source, ...g.translation])
      coverage.set(
        id,
        unionCoverage((source.get(id) ?? target.get(id))!, pairs.get(id) ?? []),
      );
  }
  const decision = (subject: string) => {
    const d = decisionFor(session, subject);
    return d
      ? `<p class="decision"><strong>${h(status(subject))}</strong> · ${h(d.at)} · ${h(d.reviewer || "Unnamed reviewer")} (unverified name)</p><p dir="auto">${h(d.comment)}</p>`
      : '<p class="decision">Unresolved</p>';
  };
  const cue = (id: string, role: "source" | "translation") => {
    const c = (role === "source" ? source : target).get(id)!;
    const covered = coverage.get(id) ?? 0;
    return `<div class="cue"><small>#${c.ordinal + 1} · ${h(displayTime(c.startMs))} → ${h(displayTime(c.endMs))} · ${covered}/${Math.max(0, c.endMs - c.startMs)} ms covered</small><pre dir="auto">${h(c.text || "[empty cue]")}</pre></div>`;
  };
  const body = analysis.alignment.groups
    .map(
      (g) =>
        `<section><h2>${h(g.type)} · ${h(displayTime(g.startMs))}–${h(displayTime(g.endMs))}</h2><p>${h(g.provenance)}${g.ambiguous ? " · ambiguous" : ""}${g.requiresManual ? " · requires manual review" : ""}</p><div class="pair"><div><h3>Source</h3>${g.source.map((id) => cue(id, "source")).join("") || "<p>No corresponding source interval</p>"}</div><div><h3>Translation</h3>${g.translation.map((id) => cue(id, "translation")).join("") || "<p>No corresponding translation interval</p>"}</div></div>${decision(g.id)}${(findingsByGroup.get(g.id) ?? []).map((f) => `<aside><strong>${h(f.ruleId)} · ${h(f.severity)}</strong><p dir="auto">${h(f.evidence)}</p><p>${h(f.explanation)}</p>${decision(f.id)}</aside>`).join("")}<details><summary>Actual internal edges (${g.edges.length})</summary><ul>${g.edges
          .slice(0, 200)
          .map(
            (e) =>
              `<li>source #${source.get(e.source)!.ordinal + 1} ↔ translation #${target.get(e.translation)!.ordinal + 1}: ${e.overlapMs} ms</li>`,
          )
          .join(
            "",
          )}</ul>${g.edges.length > 200 ? "<p>First 200 edges shown. Full mapping is in the review package.</p>" : ""}</details></section>`,
    )
    .join("");
  const diagnostics = [session.source, session.translation]
    .map(
      (d) =>
        `<h3>${h(d.filename)}</h3><ul>${d.diagnostics.map((x) => `<li>${h(x.severity)} · ${h(x.code)}: ${h(x.message)}</li>`).join("")}</ul>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>CueReviewKit reviewer report</title><style>body{font:16px/1.55 ui-sans-serif,sans-serif;color:#243630;background:#f5f4ed;max-width:1100px;margin:auto;padding:32px}h1{font-size:32px}h2{font-size:20px}h3,small{font-size:14px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;unicode-bidi:plaintext}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{background:white;padding:24px;margin:24px 0;border-top:3px solid #214f44}.cue{border-bottom:1px solid #ddd;padding:8px 0}aside{border-left:3px solid #b17520;padding-left:16px}.hash{overflow-wrap:anywhere;font-family:monospace}.decision{color:#214f44}details{font-size:13px}@media(max-width:600px){body{padding:16px}.pair{grid-template-columns:1fr}}@media print{body{background:white}section{break-inside:avoid}}</style></head><body><header><p>CueReviewKit ${VERSION} · local reviewer handoff</p><h1>Subtitle review report</h1><p>${h(session.source.filename)} → ${h(session.translation.filename)}</p><p>${analysis.alignment.incomplete ? "INCOMPLETE: " + h(analysis.alignment.reason) : !analysis.supported ? "Unsupported format: checks are limited to parsed cues." : "Mechanical checks complete. Human review may still be unresolved."} This report does not certify translation accuracy.</p><p class="hash">Review revision: ${h(analysis.revision)}</p><p class="hash">Source SHA-256: ${h(session.source.byteHash)}<br>Translation original SHA-256: ${h(session.translation.byteHash)}</p><p>Reviewer names are local, unverified labels. Hashes check integrity, not authorship. ${analysis.supported ? "Supported format subset." : "Unsupported/malformed input: corrected export blocked."}</p></header><details><summary>Format diagnostics</summary>${diagnostics}</details>${body}<details><summary>Rule preset and bounded history</summary><pre>${h(JSON.stringify(session.config, null, 2))}</pre><ul>${session.history.map((e) => `<li>${h(e.at)} · ${h(e.action)} · <span class="hash">${h(e.revision)}</span></li>`).join("")}</ul></details></body></html>`;
}
