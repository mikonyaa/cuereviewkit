export const VERSION = "0.1.0";
export const ALIGNMENT_VERSION = "time-graph/1";
export const RULE_VERSION = "mechanical/1";
export const LIMITS = {
  trackBytes: 10 * 1024 ** 2,
  cues: 20_000,
  lines: 400_000,
  diagnostics: 100_000,
  cueChars: 20_000,
  edges: 200_000,
  comment: 2_000,
  history: 200,
  decisions: 60_000,
  packageBytes: 30 * 1024 ** 2,
  unpackedBytes: 60 * 1024 ** 2,
  entries: 6,
  ratio: 200,
} as const;
export type Role = "source" | "translation";
export type Format = "srt" | "vtt";
export interface Diagnostic {
  code: string;
  severity: "error" | "warning" | "unsupported";
  message: string;
  ordinal?: number;
  line?: number;
}
export interface Cue {
  id: string;
  ordinal: number;
  number?: string;
  identifier?: string;
  startMs: number;
  endMs: number;
  text: string;
  contentHash: string;
  span: { start: number; end: number; byteStart: number; byteEnd: number };
  timingRaw: string;
  prefixRaw: string;
  newline: string;
}
export interface SourceDocument {
  role: Role;
  format: Format;
  filename: string;
  mime: string;
  bytes: Uint8Array;
  byteHash: string;
  raw: string;
  bom: boolean;
  newline: string;
  diagnostics: Diagnostic[];
  cues: Cue[];
  supported: boolean;
}
export interface Edit {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}
export interface Edge {
  source: string;
  translation: string;
  overlapMs: number;
}
export interface Mapping {
  source: string[];
  translation: string[];
  provenance: "automatic-overlap" | "automatic-near" | "manual";
}
export interface Group extends Mapping {
  id: string;
  type: "1:1" | "1:n" | "n:1" | "n:m" | "unmatched";
  startMs: number;
  endMs: number;
  requiresManual: boolean;
  ambiguous: boolean;
  nearCandidates: string[];
  edges: Edge[];
}
export interface Alignment {
  groups: Group[];
  incomplete: boolean;
  reason?: string;
  edgeCount: number;
}
export interface Config {
  toleranceMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  maxCps: number;
  minCoverage: number;
  locale: string;
}
export const DEFAULT_CONFIG: Config = {
  toleranceMs: 200,
  minDurationMs: 400,
  maxDurationMs: 7_000,
  maxCps: 25,
  minCoverage: 0.9,
  locale: "und",
};
export interface Finding {
  id: string;
  ruleId: string;
  ruleVersion: string;
  severity: "error" | "warning";
  category: "structural" | "configurable";
  scope: { role?: Role; cueIds: string[]; groupId?: string };
  evidence: string;
  explanation: string;
  config: Config;
}
export type DecisionStatus = "accepted" | "needs-change" | "waived";
export interface Decision {
  subject: string;
  subjectHash: string;
  reviewRevision: string;
  status: DecisionStatus;
  comment: string;
  reviewer: string;
  at: string;
}
export interface HistoryEntry {
  at: string;
  action: string;
  revision: string;
}
export interface ReviewInput {
  source: SourceDocument;
  translation: SourceDocument;
  edits: Edit[];
  manualMapping: Mapping[] | null;
  config: Config;
}
export interface Analysis {
  working: Cue[];
  alignment: Alignment;
  findings: Finding[];
  revision: string;
  subjectHashes: Record<string, string>;
  supported: boolean;
}
export interface Session extends ReviewInput {
  id: string;
  decisions: Decision[];
  history: HistoryEntry[];
  analysis: Analysis;
}
