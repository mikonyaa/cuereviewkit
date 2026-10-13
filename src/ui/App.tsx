import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import { store } from "./store";
import {
  VERSION,
  LIMITS,
  type Cue,
  type Group,
  type Session,
  type Finding,
  type Config,
} from "../review/types";
import { decisionFor, isDecisionCurrent } from "../review/engine";
import { displayTime, parseTime } from "../formats/time";
import { mergeGroups, splitGroup, unionCoverage } from "../alignment";
import { graphemeCount } from "../formats/markup";

type Filter =
  | "all"
  | "unresolved"
  | "unmatched"
  | "numbers"
  | "stale"
  | "reviewed"
  | "ambiguous";
function status(session: Session, subject: string) {
  const d = decisionFor(session, subject);
  return !d
    ? "unresolved"
    : isDecisionCurrent(d, session.analysis)
      ? d.status
      : "stale";
}
function nextIndex(index: number, length: number) {
  return (index + 1) % Math.max(1, length);
}
function useBoundedPage(count: number) {
  const [requested, setPage] = useState(0);
  const page = Math.min(requested, Math.max(0, Math.ceil(count / 50) - 1));
  useEffect(() => {
    if (requested !== page) setPage(page);
  }, [requested, page]);
  return [page, setPage] as const;
}
function CueBlock({
  cue,
  editable,
  onEdit,
  coverage,
}: {
  cue: Cue;
  editable?: boolean;
  onEdit?: () => void;
  coverage?: number;
}) {
  return (
    <div className="cue-block">
      <div className="cue-meta">
        <span className="mono">
          #{cue.ordinal + 1} · {displayTime(cue.startMs)} →{" "}
          {displayTime(cue.endMs)}
        </span>
        {editable && (
          <button
            className="text-button"
            onClick={onEdit}
            aria-label={`Edit translation cue ${cue.ordinal + 1}`}
          >
            Edit
          </button>
        )}
      </div>
      <pre dir="auto">{cue.text || "[empty cue]"}</pre>
      {coverage !== undefined && (
        <small className="coverage">
          Temporal coverage {coverage}/{Math.max(0, cue.endMs - cue.startMs)} ms
        </small>
      )}
    </div>
  );
}
function CueTrack({
  cues,
  role,
  session,
  coverage,
  onEdit,
  busy,
}: {
  cues: Cue[];
  role: "source" | "translation";
  session: Session;
  coverage: Map<string, number>;
  onEdit: (cue: Cue) => void;
  busy: boolean;
}) {
  const [page, setPage] = useBoundedPage(cues.length);
  const pageSize = 50;
  return (
    <section>
      <h3>
        {role === "source" ? "Source" : "Translation"}{" "}
        <span>{role === "source" ? "READ ONLY" : "WORKING COPY"}</span>
      </h3>
      {cues.slice(page * pageSize, page * pageSize + pageSize).map((c) => {
        const n =
          role === "translation"
            ? graphemeCount(c.text, session.config.locale)
            : null;
        return (
          <div key={c.id}>
            <CueBlock
              cue={c}
              coverage={coverage.get(c.id) ?? 0}
              editable={
                role === "translation" && session.translation.supported && !busy
              }
              onEdit={() => onEdit(c)}
            />
            {role === "translation" && (
              <small className="cps">
                {n !== null && c.endMs > c.startMs
                  ? `${(n / ((c.endMs - c.startMs) / 1000)).toFixed(1)} CPS · ${n} visible graphemes`
                  : "CPS not computable"}
              </small>
            )}
          </div>
        );
      })}
      {cues.length > pageSize && (
        <div className="pagination">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous cues
          </button>
          <small>
            {page * pageSize + 1}–{Math.min(cues.length, (page + 1) * pageSize)}{" "}
            / {cues.length}
          </small>
          <button
            disabled={(page + 1) * pageSize >= cues.length}
            onClick={() => setPage((p) => p + 1)}
          >
            Next cues
          </button>
        </div>
      )}
      {!cues.length && (
        <p className="unmatched-placeholder">
          No corresponding {role} interval.
          <br />
          Temporal absence does not prove missing meaning.
        </p>
      )}
    </section>
  );
}
function EditDialog({
  cue,
  session,
  onClose,
}: {
  cue: Cue;
  session: Session;
  onClose: () => void;
}) {
  const [text, setText] = useState(cue.text),
    [start, setStart] = useState(displayTime(cue.startMs)),
    [end, setEnd] = useState(displayTime(cue.endMs)),
    [preview, setPreview] = useState(false);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const startMs = parseTime(start, "vtt"),
    endMs = parseTime(end, "vtt");
  const invalid =
    startMs === null || endMs === null
      ? "Use hh:mm:ss.mmm with valid minutes and seconds."
      : text.length > LIMITS.cueChars
        ? "Text exceeds 20,000 characters."
        : text !== "" && /(?:^|\n)[ \t]*(?:\r?\n|$)/.test(text)
          ? "Blank separator lines or leading/trailing newlines are not allowed. Your draft is kept."
          : "";
  const submit = async () => {
    const previous = store.getSnapshot().session?.analysis.revision;
    await store.edit(cue.id, startMs!, endMs!, text);
    if (
      !store.getSnapshot().error &&
      store.getSnapshot().session?.analysis.revision !== previous
    )
      onClose();
    else if (!store.getSnapshot().error) onClose();
  };
  return (
    <div className="overlay">
      <section
        className="modal edit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-title"
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">
              Working translation · cue {cue.ordinal + 1}
            </span>
            <h2 id="edit-title">Preview your correction</h2>
          </div>
          <button
            onClick={onClose}
            disabled={state.busy}
            aria-label="Close editor"
          >
            Close
          </button>
        </div>
        <p>
          Only this cue fragment changes. Applying a correction makes earlier
          decisions stale.
        </p>
        <div className="time-inputs">
          <label>
            Start time
            <input
              autoFocus
              className="mono"
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                setPreview(false);
              }}
            />
          </label>
          <label>
            End time
            <input
              className="mono"
              value={end}
              onChange={(e) => {
                setEnd(e.target.value);
                setPreview(false);
              }}
            />
          </label>
        </div>
        <label>
          Translation text
          <textarea
            aria-label="Translation text"
            rows={6}
            dir="auto"
            maxLength={LIMITS.cueChars + 1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(false);
            }}
          />
        </label>
        <small>{text.length.toLocaleString()} / 20,000 characters</small>
        {invalid && (
          <p className="error" role="alert">
            {invalid}
          </p>
        )}
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        {preview && (
          <div className="diff-preview">
            <div>
              <strong>Before</strong>
              <pre dir="auto">{cue.text || "[empty]"}</pre>
              <small className="mono">
                {displayTime(cue.startMs)} → {displayTime(cue.endMs)}
              </small>
            </div>
            <div>
              <strong>After</strong>
              <pre dir="auto">{text || "[empty]"}</pre>
              <small className="mono">
                {start} → {end}
              </small>
            </div>
            <p>Original: {session.translation.filename} remains unchanged.</p>
          </div>
        )}
        <div className="actions">
          <button
            disabled={!!invalid || state.busy}
            onClick={() => setPreview(true)}
          >
            Preview change
          </button>
          <button
            className="primary"
            disabled={!preview || !!invalid || state.busy}
            onClick={() => void submit()}
          >
            Apply correction
          </button>
        </div>
      </section>
    </div>
  );
}
function DecisionEditor({
  subject,
  session,
  warning = false,
  disabled = false,
  acceptRef,
}: {
  subject: string;
  session: Session;
  warning?: boolean;
  disabled?: boolean;
  acceptRef?: Ref<HTMLButtonElement>;
}) {
  const old = decisionFor(session, subject),
    [comment, setComment] = useState(old?.comment ?? ""),
    [reviewer, setReviewer] = useState(old?.reviewer ?? "");
  return (
    <div className="decision-editor">
      <div className="section-heading">
        <strong>{warning ? "Warning decision" : "Translation decision"}</strong>
        <span className={`state-tag ${status(session, subject)}`}>
          {status(session, subject)}
        </span>
      </div>
      {old && (
        <small>
          Recorded {new Date(old.at).toLocaleString()} ·{" "}
          {old.reviewer || "Unnamed reviewer"} (unverified name)
        </small>
      )}
      <label>
        Comment
        <textarea
          rows={3}
          maxLength={LIMITS.comment}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          dir="auto"
          placeholder={
            warning
              ? "Explain why this warning is acceptable…"
              : "Record your editorial reasoning…"
          }
        />
      </label>
      <label>
        Reviewer name <span className="optional">optional, unverified</span>
        <input
          maxLength={100}
          value={reviewer}
          onChange={(e) => setReviewer(e.target.value)}
        />
      </label>
      <div className="actions">
        <button
          ref={acceptRef}
          className="primary"
          disabled={disabled}
          onClick={() =>
            store.decide(
              subject,
              warning ? "waived" : "accepted",
              comment,
              reviewer,
            )
          }
        >
          {warning ? "Waive warning" : "Accept translation"}
        </button>
        <button
          disabled={disabled}
          onClick={() =>
            store.decide(subject, "needs-change", comment, reviewer)
          }
        >
          Needs change
        </button>
      </div>
    </div>
  );
}
function RuleSettings({
  config,
  session,
  onClose,
}: {
  config: Config;
  session: Session;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(config);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const fields: [keyof Omit<Config, "locale">, string][] = [
    ["toleranceMs", "Near tolerance (ms)"],
    ["minDurationMs", "Minimum duration (ms)"],
    ["maxDurationMs", "Maximum duration (ms)"],
    ["maxCps", "Maximum CPS"],
    ["minCoverage", "Minimum coverage (0–1)"],
  ];
  return (
    <div className="overlay">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-title"
      >
        <div className="section-heading">
          <h2 id="rules-title">Project rule preset</h2>
          <button onClick={onClose} disabled={state.busy}>
            Close
          </button>
        </div>
        <p>
          These thresholds are adjustable project warnings. They do not certify
          language quality. Updating any rule makes previous decisions stale.
        </p>
        <div className="settings-grid">
          {fields.map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                step={key === "minCoverage" ? "0.05" : "1"}
                value={draft[key]}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    [key]: e.target.value === "" ? 0 : Number(e.target.value),
                  })
                }
              />
            </label>
          ))}
          <label>
            Grapheme locale
            <input
              value={draft.locale}
              maxLength={40}
              onChange={(e) => setDraft({ ...draft, locale: e.target.value })}
            />
          </label>
        </div>
        {state.error && (
          <p role="alert" className="error">
            {state.error}
          </p>
        )}
        <button
          className="primary"
          disabled={state.busy}
          onClick={async () => {
            await store.apply(
              { ...session, config: draft },
              "Changed project rule preset",
            );
            if (!store.getSnapshot().error) onClose();
          }}
        >
          Apply preset
        </button>
      </section>
    </div>
  );
}
function ImportPanel({ onDone }: { onDone?: () => void }) {
  const [source, setSource] = useState<File | null>(null),
    [translation, setTranslation] = useState<File | null>(null);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <div className="import-panel">
      <div className="file-pickers">
        <label className="file-picker">
          <span className="step-number">01</span>
          <span>
            Source subtitles<small>SRT or supported WebVTT · read only</small>
          </span>
          <input
            aria-label="Source subtitles"
            type="file"
            accept=".srt,.vtt"
            onChange={(e) => setSource(e.target.files?.[0] ?? null)}
          />
          {source && (
            <span className="chosen-file" dir="auto">
              {source.name}
            </span>
          )}
        </label>
        <label className="file-picker">
          <span className="step-number">02</span>
          <span>
            Translated subtitles<small>Your editable working copy</small>
          </span>
          <input
            aria-label="Translated subtitles"
            type="file"
            accept=".srt,.vtt"
            onChange={(e) => setTranslation(e.target.files?.[0] ?? null)}
          />
          {translation && (
            <span className="chosen-file" dir="auto">
              {translation.name}
            </span>
          )}
        </label>
      </div>
      <div className="actions">
        <button
          className="primary"
          disabled={!source || !translation || state.busy}
          onClick={async () => {
            await store.importPair(source!, translation!);
            if (!store.getSnapshot().error) onDone?.();
          }}
        >
          Start review
        </button>
        <button
          disabled={state.busy}
          onClick={async () => {
            await store.demo();
            if (!store.getSnapshot().error) onDone?.();
          }}
        >
          Try synthetic example
        </button>
      </div>
      <p className="fine-print">
        UTF-8 only · 10 MiB per track · 20,000 cues per track. Files are
        processed on your device.
      </p>
    </div>
  );
}
function FindingsPanel({
  group,
  session,
  findings,
  busy,
  acceptRef,
}: {
  group: Group;
  session: Session;
  findings: Finding[];
  busy: boolean;
  acceptRef: Ref<HTMLButtonElement>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useBoundedPage(findings.length);
  const finding = findings.find((f) => f.id === selected);
  return (
    <aside className="inspector" aria-label="Review evidence">
      <div className="inspector-heading">
        <span className="eyebrow">Editorial review</span>
        <h2>Evidence & decisions</h2>
        <small className="mono">
          Revision {session.analysis.revision.slice(0, 12)}
        </small>
      </div>
      <div className="inspector-body">
        <DecisionEditor
          key={group.id}
          subject={group.id}
          session={session}
          disabled={busy || session.analysis.alignment.incomplete}
          acceptRef={acceptRef}
        />
        <div className="findings-section">
          <div className="section-heading">
            <h3>Mechanical findings</h3>
            <span>{findings.length}</span>
          </div>
          {findings.length === 0 ? (
            <p className="muted">
              No mechanical findings in this group. Meaning still requires human
              review.
            </p>
          ) : (
            findings.slice(page * 50, page * 50 + 50).map((f) => (
              <button
                key={f.id}
                className={`finding-button ${selected === f.id ? "selected" : ""}`}
                onClick={() => setSelected(f.id)}
              >
                <span>
                  {f.severity === "error" ? "Error" : "Warning"} ·{" "}
                  {f.ruleId.replaceAll("-", " ")}
                </span>
                <small dir="auto">{f.evidence}</small>
                <span className={`state-tag ${status(session, f.id)}`}>
                  {status(session, f.id)}
                </span>
              </button>
            ))
          )}
          {findings.length > 50 && (
            <div className="pagination">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous findings
              </button>
              <small>
                {page + 1}/{Math.ceil(findings.length / 50)}
              </small>
              <button
                disabled={(page + 1) * 50 >= findings.length}
                onClick={() => setPage((p) => p + 1)}
              >
                Next findings
              </button>
            </div>
          )}
        </div>
        {finding && (
          <div className="finding-detail">
            <h3>{finding.ruleId.replaceAll("-", " ")}</h3>
            <p dir="auto">{finding.evidence}</p>
            <p>{finding.explanation}</p>
            <small>
              {finding.category} · {finding.ruleVersion}
            </small>
            <DecisionEditor
              key={finding.id}
              subject={finding.id}
              warning
              session={session}
              disabled={busy || session.analysis.alignment.incomplete}
            />
          </div>
        )}
        <details>
          <summary>Internal overlap edges ({group.edges.length})</summary>
          <ul className="edges">
            {group.edges.slice(0, 100).map((e, i) => (
              <li key={i}>
                <span className="mono">{e.overlapMs} ms</span> of actual
                intersection
              </li>
            ))}
          </ul>
          {group.edges.length > 100 && (
            <p>First 100 shown. The package preserves full mapping.</p>
          )}
        </details>
        {group.nearCandidates.length > 0 && (
          <p className="callout">
            Near candidates remain ambiguous. Split and regroup manually to
            choose a correspondence.
          </p>
        )}
      </div>
    </aside>
  );
}
export function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot),
    session = state.session;
  const [filter, setFilter] = useState<Filter>("all"),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [edit, setEdit] = useState<Cue | null>(null),
    [rules, setRules] = useState(false),
    [importing, setImporting] = useState(false),
    [exporting, setExporting] = useState(false),
    [checks, setChecks] = useState<Set<string>>(new Set());
  const currentRow = useRef<HTMLButtonElement | null>(null);
  const focusQueue = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const acceptRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    void store.init();
  }, []);
  const maps = useMemo(
    () =>
      session
        ? {
            source: new Map(session.source.cues.map((c) => [c.id, c])),
            translation: new Map(
              session.analysis.working.map((c) => [c.id, c]),
            ),
          }
        : null,
    [session],
  );
  const findingMap = useMemo(() => {
    const result = new Map<string, Finding[]>();
    if (!session) return result;
    const owner = new Map<string, string>();
    session.analysis.alignment.groups.forEach((g) =>
      [...g.source, ...g.translation].forEach((id) => owner.set(id, g.id)),
    );
    for (const f of session.analysis.findings)
      for (const gid of new Set(
        f.scope.groupId
          ? [f.scope.groupId]
          : f.scope.cueIds
              .map((id) => owner.get(id))
              .filter((s): s is string => !!s),
      )) {
        if (!result.has(gid)) result.set(gid, []);
        result.get(gid)!.push(f);
      }
    return result;
  }, [session]);
  const groups = useMemo(() => {
    if (!session || !maps) return [];
    return session.analysis.alignment.groups.filter((g) => {
      const st = status(session, g.id),
        findings = findingMap.get(g.id) ?? [];
      const matches =
        filter === "all" ||
        (filter === "unresolved" &&
          (st === "unresolved" ||
            st === "stale" ||
            st === "needs-change" ||
            findings.some((f) =>
              ["unresolved", "stale", "needs-change"].includes(
                status(session, f.id),
              ),
            ))) ||
        (filter === "unmatched" && g.type === "unmatched") ||
        (filter === "numbers" &&
          findings.some((f) => f.ruleId.startsWith("number-"))) ||
        (filter === "stale" &&
          (st === "stale" ||
            findings.some((f) => status(session, f.id) === "stale"))) ||
        (filter === "reviewed" && st === "accepted") ||
        (filter === "ambiguous" && (g.ambiguous || g.requiresManual));
      return (
        matches &&
        (!query ||
          [...g.source, ...g.translation].some((id) =>
            (maps.source.get(id) ?? maps.translation.get(id))!.text
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()),
          ))
      );
    });
  }, [session, maps, filter, query, findingMap]);
  const [listPage, setListPage] = useBoundedPage(groups.length);
  const visibleGroups = groups.slice(listPage * 50, listPage * 50 + 50);
  const group =
    visibleGroups.find((g) => g.id === selected) ?? visibleGroups[0];
  const authoringKey = `${state.sessionEpoch}:${session?.analysis.revision}`;
  const findings = group ? (findingMap.get(group.id) ?? []) : [];
  const coverage = useMemo(() => {
    const result = new Map<string, number>();
    if (!group || !maps) return result;
    const pairs = new Map<string, Cue[]>();
    for (const edge of group.edges) {
      if (!pairs.has(edge.source)) pairs.set(edge.source, []);
      if (!pairs.has(edge.translation)) pairs.set(edge.translation, []);
      pairs.get(edge.source)!.push(maps.translation.get(edge.translation)!);
      pairs.get(edge.translation)!.push(maps.source.get(edge.source)!);
    }
    for (const id of [...group.source, ...group.translation])
      result.set(
        id,
        unionCoverage(
          (maps.source.get(id) ?? maps.translation.get(id))!,
          pairs.get(id) ?? [],
        ),
      );
    return result;
  }, [group, maps]);
  useEffect(() => {
    setListPage(0);
    setSelected(null);
    setChecks(new Set());
  }, [filter, query, state.sessionEpoch, setListPage]);
  useEffect(() => {
    if (group) {
      currentRow.current?.scrollIntoView({ block: "nearest" });
      if (focusQueue.current) {
        currentRow.current?.focus();
        focusQueue.current = false;
      }
    }
  }, [group?.id, listPage, state.sessionEpoch]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.closest('input,textarea,select,[contenteditable="true"]') ||
        e.altKey ||
        e.metaKey ||
        e.ctrlKey ||
        edit ||
        rules ||
        importing ||
        state.packagePreview ||
        exporting
      )
        return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "j" || e.key === "n") {
        e.preventDefault();
        const i = groups.findIndex((g) => g.id === group?.id);
        const next = groups[nextIndex(i, groups.length)];
        if (next) {
          focusQueue.current = true;
          setSelected(next.id);
          setListPage(Math.floor(nextIndex(i, groups.length) / 50));
        }
      }
      if (e.key === "k") {
        e.preventDefault();
        const i = groups.findIndex((g) => g.id === group?.id),
          n = (i - 1 + groups.length) % groups.length;
        if (groups[n]) {
          focusQueue.current = true;
          setSelected(groups[n].id);
          setListPage(Math.floor(n / 50));
        }
      }
      if (e.key === "a" && session && group && !state.busy) {
        e.preventDefault();
        acceptRef.current?.click();
      }
      if (
        e.key === "e" &&
        session &&
        group?.translation[0] &&
        session.translation.supported
      )
        setEdit(maps!.translation.get(group.translation[0])!);
      if (e.key === "u" && !state.busy) void store.undoEdit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    groups,
    group,
    session,
    maps,
    state.busy,
    edit,
    rules,
    importing,
    state.packagePreview,
    exporting,
  ]);
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (session && (edit || state.autosave !== "Recovery saved locally")) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [session, edit, state.autosave]);
  useEffect(() => {
    if (!edit && !rules && !importing && !exporting && !state.packagePreview)
      return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !state.busy) {
        setEdit(null);
        setRules(false);
        setImporting(false);
        setExporting(false);
        store.dismissPackage();
      }
      if (e.key === "Tab") {
        const dialog = document.querySelector('[role="dialog"]');
        const nodes = dialog?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)",
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const first = document.querySelector<HTMLElement>(
      '[role="dialog"] button,[role="dialog"] input',
    );
    first?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [edit, rules, importing, exporting, state.packagePreview, state.busy]);
  const switchFilter = (f: Filter) => {
    setFilter(f);
    setSelected(null);
    setChecks(new Set());
  };
  const merge = async () => {
    if (!session) return;
    const mapping = session.analysis.alignment.groups,
      indices = mapping
        .map((g, i) => (checks.has(g.id) ? i : -1))
        .filter((i) => i >= 0);
    await store.apply(
      { ...session, manualMapping: mergeGroups(mapping, indices) },
      "Manually merged mapping groups",
    );
    setChecks(new Set());
  };
  const split = async () => {
    if (!session || !group) return;
    const mapping = session.analysis.alignment.groups;
    await store.apply(
      {
        ...session,
        manualMapping: splitGroup(mapping, mapping.indexOf(group)),
      },
      "Manually split mapping into unmatched singleton groups",
    );
    setChecks(new Set());
  };
  const totals = session
    ? {
        groups: session.analysis.alignment.groups.length,
        accepted: session.analysis.alignment.groups.filter(
          (g) => status(session, g.id) === "accepted",
        ).length,
        stale: session.decisions.filter(
          (d) => !isDecisionCurrent(d, session.analysis),
        ).length,
      }
    : null;
  return (
    <>
      <a className="skip-link" href="#workspace">
        Skip to review
      </a>
      <header className="app-header">
        <a className="brand" href="#">
          <span className="brand-mark">
            cr<span>/</span>
          </span>
          <span>
            CueReviewKit<small>SUBTITLE REVIEW WORKBENCH</small>
          </span>
        </a>
        <div className="header-actions">
          <span className="local-label">Files stay on this device</span>
          <label className={`button ${state.busy ? "disabled" : ""}`}>
            Open package
            <input
              className="visually-hidden"
              aria-label="Open review package"
              type="file"
              accept=".zip"
              disabled={state.busy}
              onChange={(e) => {
                if (e.target.files?.[0])
                  void store.previewPackage(e.target.files[0]);
                e.target.value = "";
              }}
            />
          </label>
          {session && (
            <>
              <button disabled={state.busy} onClick={() => setImporting(true)}>
                Import pair
              </button>
              <button
                className="primary"
                disabled={state.busy}
                onClick={() => setExporting(true)}
              >
                Export handoff
              </button>
            </>
          )}
        </div>
      </header>
      <div className="announcement" role="status">
        {state.busy ? (
          <>
            <span className="spinner" />
            Calculating in a local worker…{" "}
            <button className="text-button" onClick={() => store.cancel()}>
              Cancel calculation
            </button>
          </>
        ) : state.error ? (
          <span className="error" role="alert">
            {state.error}
          </span>
        ) : (
          state.message ||
          "Review source and translated subtitles before delivery."
        )}
      </div>
      {!session ? (
        <main id="workspace" className="welcome">
          <div className="welcome-copy">
            <span className="eyebrow">A careful pass, before delivery</span>
            <h1>
              Two tracks.
              <br />
              One review.
              <br />
              <span>Every decision visible.</span>
            </h1>
            <p>
              Match original and translated subtitles by time. Inspect split and
              merged cues, record a decision, and hand off a review that can be
              reopened.
            </p>
            <div className="principles">
              <span>Temporal alignment</span>
              <span>Versioned decisions</span>
              <span>Portable review package</span>
            </div>
          </div>
          <section className="welcome-import">
            <div className="section-heading">
              <h2>Open a subtitle pair</h2>
              <span className="mono">01 / IMPORT</span>
            </div>
            <ImportPanel />
            <div className="welcome-note">
              <strong>Mechanical checks support your judgment.</strong>
              <p>
                They cannot establish translation accuracy or prove that meaning
                is missing. Review both languages in context.
              </p>
            </div>
            {state.recovery && (
              <div className="recovery">
                <strong>Local recovery found</strong>
                <p>
                  {state.recovery.source.filename} →{" "}
                  {state.recovery.translation.filename}
                  <br />
                  {state.recoveryAt}
                </p>
                <div className="actions">
                  <button
                    disabled={state.busy}
                    onClick={() => void store.restoreRecovery()}
                  >
                    Restore recovery
                  </button>
                  <button onClick={() => store.dismissRecovery()}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </section>
          <footer className="welcome-footer">
            <span>v{VERSION} · Experimental release</span>
            <span>{state.autosave}</span>
            <span>UTF-8 SRT / limited WebVTT</span>
          </footer>
        </main>
      ) : (
        <main id="workspace" className="workspace">
          <div className="project-bar">
            <div className="track-label">
              <span className="eyebrow">Source · read only</span>
              <strong dir="auto">{session.source.filename}</strong>
              <small>
                {session.source.cues.length} cues ·{" "}
                {session.source.format.toUpperCase()} · SHA{" "}
                {session.source.byteHash.slice(0, 8)}
              </small>
              <label className="text-button">
                Replace source
                <input
                  className="visually-hidden"
                  aria-label="Replace source"
                  type="file"
                  accept=".srt,.vtt"
                  disabled={state.busy}
                  onChange={(e) => {
                    if (e.target.files?.[0])
                      void store.replaceTrack(e.target.files[0], "source");
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <div className="track-label">
              <span className="eyebrow">Translation · working copy</span>
              <strong dir="auto">{session.translation.filename}</strong>
              <small>
                {session.analysis.working.length} cues · {session.edits.length}{" "}
                edited · original SHA {session.translation.byteHash.slice(0, 8)}
              </small>
              <label className="text-button">
                Replace translation
                <input
                  className="visually-hidden"
                  aria-label="Replace translation"
                  type="file"
                  accept=".srt,.vtt"
                  disabled={state.busy}
                  onChange={(e) => {
                    if (e.target.files?.[0])
                      void store.replaceTrack(e.target.files[0], "translation");
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <div className="review-progress">
              <strong>
                {totals!.accepted} <span>/ {totals!.groups}</span>
              </strong>
              <small>translation groups accepted</small>
              <div className="progress-track">
                <span
                  style={{
                    width: `${(100 * totals!.accepted) / Math.max(1, totals!.groups)}%`,
                  }}
                />
              </div>
            </div>
          </div>
          {(!session.analysis.supported ||
            session.analysis.alignment.incomplete) && (
            <div className="format-banner">
              <strong>
                {session.analysis.alignment.incomplete
                  ? "Incomplete analysis"
                  : "Unsupported or malformed format"}
              </strong>
              <p>
                {session.analysis.alignment.reason ||
                  "Corrected export is blocked for affected documents. All original bytes remain downloadable."}
              </p>
              <details>
                <summary>Read format diagnostics</summary>
                {[session.source, session.translation].map((d) => (
                  <div key={d.role}>
                    <strong>{d.filename}</strong>
                    <ul>
                      {d.diagnostics.map((x, i) => (
                        <li key={i}>
                          {x.severity} · {x.code}: {x.message}
                          {x.line ? ` (line ${x.line})` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </details>
            </div>
          )}
          <div className="workbench">
            <aside className="filters" aria-label="Review filters">
              <span className="eyebrow">Review queue</span>
              {(
                [
                  ["all", "All groups"],
                  ["unresolved", "Unresolved"],
                  ["unmatched", "Unmatched intervals"],
                  ["numbers", "Number evidence"],
                  ["ambiguous", "Ambiguous / large"],
                  ["stale", "Stale decisions"],
                  ["reviewed", "Accepted groups"],
                ] as [Filter, string][]
              ).map(([f, label]) => (
                <button
                  key={f}
                  className={filter === f ? "active" : ""}
                  aria-pressed={filter === f}
                  onClick={() => switchFilter(f)}
                >
                  {label}
                  {f === "all" && <span>{totals!.groups}</span>}
                  {f === "stale" && <span>{totals!.stale}</span>}
                </button>
              ))}
              <div className="filter-bottom">
                <button disabled={state.busy} onClick={() => setRules(true)}>
                  Rule preset
                </button>
                <button
                  disabled={state.busy || !state.undoCount}
                  onClick={() => void store.undoEdit()}
                >
                  Undo edit ({state.undoCount})
                </button>
                <details>
                  <summary>Keyboard workflow</summary>
                  <p>
                    <kbd>j</kbd>/<kbd>k</kbd> next/previous group
                    <br />
                    <kbd>n</kbd> next in current queue
                    <br />
                    <kbd>e</kbd> edit translation
                    <br />
                    <kbd>a</kbd> accept translation
                    <br />
                    <kbd>u</kbd> undo
                    <br />
                    <kbd>/</kbd> search
                    <br />
                    Keys pause inside input fields.
                  </p>
                </details>
                <p className="fine-print">
                  Warnings and translation decisions are reviewed separately.
                </p>
              </div>
            </aside>
            <section className="review-center" aria-label="Bilingual review">
              <div className="review-toolbar">
                <label className="search">
                  <span className="visually-hidden">Search subtitle text</span>
                  <input
                    ref={searchRef}
                    type="search"
                    placeholder="Search both tracks…"
                    aria-label="Search subtitle text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <span className="mono">{groups.length} groups</span>
                <button
                  disabled={!groups.length}
                  onClick={() => {
                    const i = groups.findIndex((g) => g.id === group?.id),
                      n = nextIndex(i, groups.length);
                    focusQueue.current = true;
                    setSelected(groups[n].id);
                    setListPage(Math.floor(n / 50));
                  }}
                >
                  Next in queue
                </button>
              </div>
              <div className="mapping-toolbar">
                <small>
                  {checks.size
                    ? `${checks.size} groups selected`
                    : "Select groups to change their mapping"}
                </small>
                <button
                  disabled={checks.size < 2 || state.busy}
                  onClick={() => void merge()}
                >
                  Merge selected mapping
                </button>
                <button
                  disabled={
                    !group ||
                    state.busy ||
                    group.source.length + group.translation.length < 2
                  }
                  onClick={() => void split()}
                >
                  Split current mapping
                </button>
              </div>
              <div className="group-list" aria-label="Temporal groups">
                {visibleGroups.map((g) => (
                  <div
                    key={g.id}
                    className={`group-row ${group?.id === g.id ? "current" : ""}`}
                  >
                    <input
                      aria-label={`Select mapping ${g.id}`}
                      type="checkbox"
                      checked={checks.has(g.id)}
                      onChange={(e) => {
                        const next = new Set(checks);
                        if (e.target.checked) next.add(g.id);
                        else next.delete(g.id);
                        setChecks(next);
                      }}
                    />
                    <button
                      ref={group?.id === g.id ? currentRow : undefined}
                      className="group-select"
                      aria-label={`Review ${g.type} group at ${displayTime(g.startMs)}`}
                      aria-current={group?.id === g.id ? "true" : undefined}
                      onClick={() => setSelected(g.id)}
                    >
                      <span className="group-time mono">
                        {displayTime(g.startMs)}
                      </span>
                      <span className="group-description">
                        <strong>
                          {g.type === "unmatched"
                            ? "Unmatched interval"
                            : g.type === "n:1"
                              ? `${g.source.length} → 1 merge`
                              : g.type === "1:n"
                                ? `1 → ${g.translation.length} split`
                                : g.type === "n:m"
                                  ? `${g.source.length} ↔ ${g.translation.length} group`
                                  : "1 ↔ 1 pair"}
                        </strong>
                        <small>
                          {g.type === "unmatched" &&
                          g.provenance === "automatic-overlap"
                            ? "no overlap"
                            : g.provenance.replace("automatic-", "")}
                          {g.ambiguous ? " · ambiguous" : ""}
                          {g.requiresManual
                            ? " · manual review required"
                            : ""}{" "}
                          · {(findingMap.get(g.id) ?? []).length} findings
                        </small>
                      </span>
                      <span className={`state-tag ${status(session, g.id)}`}>
                        {status(session, g.id)}
                      </span>
                    </button>
                  </div>
                ))}
                {groups.length === 0 && (
                  <p className="empty-state">
                    No groups in this view. Try another filter or clear the
                    search.
                  </p>
                )}
              </div>
              {groups.length > 50 && (
                <div className="pagination">
                  <button
                    disabled={listPage === 0}
                    onClick={() => {
                      focusQueue.current = true;
                      setSelected(null);
                      setListPage((p) => p - 1);
                    }}
                  >
                    Previous 50
                  </button>
                  <small>
                    Page {listPage + 1} of {Math.ceil(groups.length / 50)}
                  </small>
                  <button
                    disabled={(listPage + 1) * 50 >= groups.length}
                    onClick={() => {
                      focusQueue.current = true;
                      setSelected(null);
                      setListPage((p) => p + 1);
                    }}
                  >
                    Next 50
                  </button>
                </div>
              )}
              {group && maps && (
                <article className="bilingual-group">
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">Active temporal group</span>
                      <h2>
                        {group.type === "unmatched"
                          ? "Unmatched interval"
                          : `${group.source.length} source → ${group.translation.length} translation`}
                      </h2>
                    </div>
                    <span className="mono">
                      {displayTime(group.startMs)}–{displayTime(group.endMs)}
                    </span>
                  </div>
                  {(group.ambiguous || group.requiresManual) && (
                    <p className="callout">
                      {group.ambiguous
                        ? "Ambiguous near candidates. Choose a correspondence using manual split/merge."
                        : "Large overlap chain. Inspect internal edges and split/regroup before accepting."}
                    </p>
                  )}
                  <div className="bilingual-columns">
                    <CueTrack
                      key={`${authoringKey}:${group.id}:source`}
                      cues={group.source.map((id) => maps.source.get(id)!)}
                      role="source"
                      session={session}
                      coverage={coverage}
                      onEdit={setEdit}
                      busy={state.busy}
                    />
                    <CueTrack
                      key={`${authoringKey}:${group.id}:translation`}
                      cues={group.translation.map((id) =>
                        maps.translation.get(id)!,
                      )}
                      role="translation"
                      session={session}
                      coverage={coverage}
                      onEdit={setEdit}
                      busy={state.busy}
                    />
                  </div>
                </article>
              )}
            </section>
            {group && (
              <FindingsPanel
                key={`${authoringKey}:${group.id}`}
                group={group}
                session={session}
                findings={findings}
                busy={state.busy}
                acceptRef={acceptRef}
              />
            )}
          </div>
          <footer className="workspace-footer">
            <span
              className={
                state.autosave.includes("failed") ||
                state.autosave.includes("conflict")
                  ? "error"
                  : ""
              }
            >
              {state.autosave}
            </span>
            <span className="mono">
              revision {session.analysis.revision.slice(0, 12)}
            </span>
            <span>
              Mechanical checks{" "}
              {session.analysis.alignment.incomplete
                ? "incomplete"
                : !session.analysis.supported
                  ? "limited to parsed cues"
                  : "complete"}{" "}
              · meaning needs human review
            </span>
          </footer>
        </main>
      )}
      {importing && (
        <div className="overlay">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-title"
          >
            <div className="section-heading">
              <h2 id="import-title">Start a separate review</h2>
              <button onClick={() => setImporting(false)} disabled={state.busy}>
                Close
              </button>
            </div>
            <p>
              Export a handoff of your current work before opening another pair.
            </p>
            <button
              disabled={state.busy}
              onClick={() => void store.download("package")}
            >
              Download current package
            </button>
            <ImportPanel
              onDone={() => {
                focusQueue.current = true;
                setImporting(false);
                switchFilter("all");
              }}
            />
          </section>
        </div>
      )}
      {edit && session && (
        <EditDialog
          cue={edit}
          session={session}
          onClose={() => setEdit(null)}
        />
      )}
      {rules && session && (
        <RuleSettings
          config={session.config}
          session={session}
          onClose={() => setRules(false)}
        />
      )}
      {state.packagePreview && (
        <div className="overlay">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="package-title"
          >
            <h2 id="package-title">Verified package preview</h2>
            <p>Creator v{state.packagePreview.creatorVersion} · schema 1</p>
            <p dir="auto">
              {state.packagePreview.session.source.filename} (
              {state.packagePreview.session.source.cues.length} cues)
              <br />
              {state.packagePreview.session.translation.filename} (
              {state.packagePreview.session.translation.cues.length} cues)
            </p>
            <p className="mono">
              Revision{" "}
              {state.packagePreview.session.analysis.revision.slice(0, 16)}
            </p>
            {state.packagePreview.warnings.map((w) => (
              <p className="callout" key={w}>
                {w}
              </p>
            ))}
            <p>
              Opens as a separate review session. Payload hashes have been
              checked; reviewer identity is unverified. Imported HTML is
              ignored.
            </p>
            {session && (
              <>
                <p>Save your current review before replacing this view.</p>
                <button
                  disabled={state.busy}
                  onClick={() => void store.download("package")}
                >
                  Download current package
                </button>
              </>
            )}
            <div className="actions">
              <button
                className="primary"
                onClick={() => {
                  focusQueue.current = true;
                  store.confirmPackage();
                  switchFilter("all");
                }}
              >
                Open as separate review
              </button>
              <button onClick={() => store.dismissPackage()}>
                Cancel import
              </button>
            </div>
          </section>
        </div>
      )}
      {exporting && session && (
        <div className="overlay">
          <section
            className="modal export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-title"
          >
            <div className="section-heading">
              <h2 id="export-title">Export your handoff</h2>
              <button disabled={state.busy} onClick={() => setExporting(false)}>
                Close
              </button>
            </div>
            <p>
              {totals!.accepted}/{totals!.groups} translation groups accepted.{" "}
              {totals!.stale} earlier decisions are stale. Unresolved states
              remain visible in every report.
            </p>
            <div className="export-options">
              <button
                disabled={state.busy}
                onClick={() => void store.download("package")}
              >
                <strong>Review package</strong>
                <small>
                  Originals, working copy, mapping, decisions and regenerated
                  report · ZIP
                </small>
              </button>
              <button
                disabled={state.busy}
                onClick={() => void store.download("report")}
              >
                <strong>Reviewer report</strong>
                <small>Standalone safe HTML · opens offline with file://</small>
              </button>
              <button
                disabled={state.busy || !session.translation.supported}
                onClick={() => void store.download("corrected")}
              >
                <strong>Corrected translation copy</strong>
                <small>Strict serialize → reparse check · new filename</small>
              </button>
              <button
                disabled={state.busy}
                onClick={() => void store.download("source")}
              >
                <strong>Untouched source</strong>
                <small>
                  Exact original bytes · SHA{" "}
                  {session.source.byteHash.slice(0, 12)}
                </small>
              </button>
              <button
                disabled={state.busy}
                onClick={() => void store.download("translation")}
              >
                <strong>Untouched translation</strong>
                <small>
                  Exact original bytes · SHA{" "}
                  {session.translation.byteHash.slice(0, 12)}
                </small>
              </button>
            </div>
            {state.error && (
              <p role="alert" className="error">
                {state.error}
              </p>
            )}
            <p className="fine-print">
              Mechanical checks are advisory. A handoff cannot certify
              translation quality.
            </p>
          </section>
        </div>
      )}
    </>
  );
}
