import { EngineClient } from "../workers/client";
import {
  LIMITS,
  type Session,
  type ReviewInput,
  type Role,
  type DecisionStatus,
} from "../review/types";
import { addDecision } from "../review/engine";
import { UndoHistory, withHistory } from "../history";
import { loadRecovery, saveRecovery } from "../storage";
export interface State {
  session: Session | null;
  busy: boolean;
  message: string;
  error: string;
  autosave: string;
  recovery: Session | null;
  recoveryAt: string;
  packagePreview: {
    session: Session;
    warnings: string[];
    creatorVersion: string;
  } | null;
  generation: number;
  undoCount: number;
}
export class ReviewStore {
  private state: State = {
    session: null,
    busy: false,
    message: "",
    error: "",
    autosave: "Recovery: checking storage…",
    recovery: null,
    recoveryAt: "",
    packagePreview: null,
    generation: 0,
    undoCount: 0,
  };
  private listeners = new Set<() => void>();
  readonly client = new EngineClient();
  private undo = new UndoHistory();
  private token: string | null = null;
  private ready = false;
  private saveRunning = false;
  private savePending: Session | null = null;
  private storageConflict = false;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.state;
  private update(partial: Partial<State>) {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((fn) => fn());
  }
  private async task<T>(
    fn: (generation: number) => Promise<T>,
  ): Promise<T | undefined> {
    const generation = this.state.generation + 1;
    this.update({ busy: true, error: "", message: "", generation });
    try {
      return await fn(generation);
    } catch (e) {
      if (this.state.generation === generation)
        this.update({
          error: e instanceof Error ? e.message : "Operation failed.",
        });
      return undefined;
    } finally {
      if (this.state.generation === generation) this.update({ busy: false });
    }
  }
  async init() {
    try {
      const record = await loadRecovery();
      this.token = record?.token ?? null;
      this.update({
        recovery: record?.session ?? null,
        recoveryAt: record?.savedAt ?? "",
        autosave: record ? "Recovery available" : "Recovery ready",
      });
    } catch (e) {
      this.update({
        autosave: e instanceof Error ? e.message : "Recovery unavailable",
      });
      this.storageConflict = true;
    } finally {
      this.ready = true;
      if (this.savePending && !this.saveRunning) void this.flushSave();
    }
  }
  private persist(session: Session) {
    this.savePending = session;
    if (!this.saveRunning) void this.flushSave();
  }
  private async flushSave() {
    if (!this.ready || this.storageConflict) return;
    this.saveRunning = true;
    while (this.savePending) {
      const snapshot = this.savePending;
      this.savePending = null;
      this.update({ autosave: "Saving recovery…" });
      try {
        this.token = await saveRecovery(snapshot, this.token);
        this.update({
          autosave: this.savePending
            ? "Saving newer revision…"
            : "Recovery saved locally",
        });
      } catch (e) {
        this.storageConflict = true;
        this.update({
          autosave:
            e instanceof Error
              ? e.message
              : "Autosave failed. Download a package.",
        });
        break;
      }
    }
    this.saveRunning = false;
  }
  private commit(session: Session) {
    this.update({ session, undoCount: this.undo.size });
    this.persist(session);
  }
  cancel() {
    this.client.cancel();
    this.update({
      busy: false,
      generation: this.state.generation + 1,
      error: "Calculation cancelled. Current review was kept.",
    });
  }
  async importPair(source: File, translation: File) {
    await this.task(async (generation) => {
      for (const f of [source, translation])
        if (f.size > LIMITS.trackBytes)
          throw new Error("Track exceeds 10 MiB. Current review was kept.");
      const [s, t] = await Promise.all([
        source.arrayBuffer(),
        translation.arrayBuffer(),
      ]);
      const session = await this.client.run(
        "pair",
        {
          source: {
            bytes: new Uint8Array(s),
            filename: source.name,
            role: "source",
            mime: source.type,
          },
          translation: {
            bytes: new Uint8Array(t),
            filename: translation.name,
            role: "translation",
            mime: translation.type,
          },
        },
        generation,
      );
      if (generation !== this.state.generation) return;
      this.undo.clear();
      this.commit(session);
      this.update({
        message: "Original pair imported. Review decisions are unresolved.",
        recovery: null,
      });
    });
  }
  async demo() {
    await this.task(async (generation) => {
      const responses = await Promise.all(
        ["source.srt", "translation.srt"].map((name) =>
          fetch(`${import.meta.env.BASE_URL}examples/${name}`),
        ),
      );
      if (responses.some((r) => !r.ok))
        throw new Error("Built-in synthetic example unavailable.");
      const [a, b] = await Promise.all(responses.map((r) => r.arrayBuffer()));
      const session = await this.client.run(
        "pair",
        {
          source: {
            bytes: new Uint8Array(a),
            filename: "source.srt",
            role: "source",
          },
          translation: {
            bytes: new Uint8Array(b),
            filename: "translation.srt",
            role: "translation",
          },
        },
        generation,
      );
      if (generation !== this.state.generation) return;
      this.undo.clear();
      this.commit(session);
      this.update({
        message:
          "Synthetic tram-guide example: 240 source / 239 translation cues.",
        recovery: null,
      });
    });
  }
  async apply(input: ReviewInput, action: string) {
    const previous = this.state.session;
    if (!previous) return;
    await this.task(async (generation) => {
      const analysis = await this.client.run("analyze", input, generation);
      if (generation !== this.state.generation) return;
      this.undo.push(previous);
      this.commit(withHistory({ ...previous, ...input, analysis }, action));
      this.update({
        message:
          "Revision changed. Previous decisions are stale until reviewed again.",
      });
    });
  }
  async edit(id: string, startMs: number, endMs: number, text: string) {
    const session = this.state.session;
    if (!session) return;
    await this.task(async (generation) => {
      const edits = [
        ...session.edits.filter((e) => e.id !== id),
        { id, startMs, endMs, text },
      ];
      await this.client.run(
        "corrected",
        { document: session.translation, edits },
        generation,
      );
      const input = { ...session, edits },
        analysis = await this.client.run("analyze", input, generation);
      if (generation !== this.state.generation) return;
      this.undo.push(session);
      this.commit(
        withHistory({ ...input, analysis }, "Edited translation cue"),
      );
      this.update({ message: "Edit applied. Previous decisions are stale." });
    });
  }
  async replaceTrack(file: File, role: Role) {
    const session = this.state.session;
    if (!session) return;
    await this.task(async (generation) => {
      if (file.size > LIMITS.trackBytes)
        throw new Error("Track exceeds 10 MiB.");
      const doc = await this.client.run(
        "track",
        {
          bytes: new Uint8Array(await file.arrayBuffer()),
          filename: file.name,
          role,
          mime: file.type,
        },
        generation,
      );
      const input = {
        ...session,
        [role]: doc,
        edits: role === "translation" ? [] : session.edits,
        manualMapping: null,
      };
      const analysis = await this.client.run("analyze", input, generation);
      if (generation !== this.state.generation) return;
      this.undo.push(session);
      this.commit(
        withHistory({ ...input, analysis }, `Replaced ${role} track`),
      );
      this.update({
        message:
          "Track replaced; mapping recomputed. Previous approvals require rechecking.",
      });
    });
  }
  async undoEdit() {
    const input = this.undo.pop(),
      session = this.state.session;
    if (!input || !session) return;
    await this.task(async (generation) => {
      const analysis = await this.client.run("analyze", input, generation);
      if (generation !== this.state.generation) return;
      this.commit(
        withHistory(
          { ...session, ...input, analysis },
          "Undo restored previous data revision",
        ),
      );
      this.update({
        message: "Previous data restored. History remains available.",
      });
    });
  }
  decide(
    subject: string,
    status: DecisionStatus,
    comment: string,
    reviewer: string,
  ) {
    if (!this.state.session || this.state.busy) return;
    try {
      this.commit(
        addDecision(this.state.session, subject, status, comment, reviewer),
      );
      this.update({
        message: "Decision recorded for this revision.",
        error: "",
      });
    } catch (e) {
      this.update({
        error: e instanceof Error ? e.message : "Decision failed.",
      });
    }
  }
  async previewPackage(file: File) {
    await this.task(async (generation) => {
      if (file.size > LIMITS.packageBytes)
        throw new Error("Package exceeds 30 MiB.");
      const preview = await this.client.run(
        "import",
        new Uint8Array(await file.arrayBuffer()),
        generation,
      );
      if (generation !== this.state.generation) return;
      this.update({ packagePreview: preview });
    });
  }
  confirmPackage() {
    const p = this.state.packagePreview;
    if (!p) return;
    this.undo.clear();
    this.commit(p.session);
    this.update({
      packagePreview: null,
      recovery: null,
      message:
        p.warnings.join(" ") ||
        "Package opened as a separate review session. Imported HTML was ignored.",
    });
  }
  dismissPackage() {
    this.update({ packagePreview: null });
  }
  async restoreRecovery() {
    const session = this.state.recovery;
    if (!session) return;
    await this.task(async (generation) => {
      const restored = await this.client.run("recovery", session, generation);
      if (generation !== this.state.generation) return;
      this.undo.clear();
      this.commit(restored);
      this.update({
        recovery: null,
        message: "Recovery revalidated and restored.",
      });
    });
  }
  dismissRecovery() {
    this.update({ recovery: null });
  }
  async download(
    kind: "package" | "report" | "corrected" | "source" | "translation",
  ) {
    const session = this.state.session;
    if (!session) return;
    await this.task(async (generation) => {
      let data: Uint8Array | string, name: string, type: string;
      if (kind === "source" || kind === "translation") {
        data = session[kind].bytes;
        name = session[kind].filename;
        type = "application/octet-stream";
      } else if (kind === "corrected") {
        data = await this.client.run(
          "corrected",
          { document: session.translation, edits: session.edits },
          generation,
        );
        name =
          session.translation.filename.replace(/\.(srt|vtt)$/i, "") +
          ".corrected." +
          session.translation.format;
        type = "text/plain";
      } else if (kind === "report") {
        data = await this.client.run("report", session, generation);
        name = "report.html";
        type = "text/html";
      } else {
        data = await this.client.run("package", session, generation);
        name = "review.cue-review.zip";
        type = "application/zip";
      }
      if (generation !== this.state.generation) return;
      const blob = new Blob(
          [typeof data === "string" ? data : new Uint8Array(data).buffer],
          { type },
        ),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      this.update({
        message: `Downloaded ${name}. Original files were preserved.`,
      });
    });
  }
}
export const store = new ReviewStore();
