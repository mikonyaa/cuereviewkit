import { LIMITS, type Session, type ReviewInput } from "../review/types";
export class UndoHistory {
  private stack: ReviewInput[] = [];
  push(session: Session) {
    this.stack.push({
      source: session.source,
      translation: session.translation,
      edits: session.edits,
      manualMapping: session.manualMapping,
      config: session.config,
    });
    if (this.stack.length > 30) this.stack.shift();
  }
  pop() {
    return this.stack.pop();
  }
  peek() {
    return this.stack.at(-1);
  }
  get size() {
    return this.stack.length;
  }
  clear() {
    this.stack = [];
  }
}
export function withHistory(session: Session, action: string): Session {
  return {
    ...session,
    history: [
      ...session.history,
      {
        at: new Date().toISOString(),
        action: action.slice(0, 2_000),
        revision: session.analysis.revision,
      },
    ].slice(-LIMITS.history),
  };
}
