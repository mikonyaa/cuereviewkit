import type {
  Analysis,
  Role,
  Session,
  ReviewInput,
  SourceDocument,
} from "../review/types";
export interface FileInput {
  bytes: Uint8Array;
  filename: string;
  role: Role;
  mime?: string;
}
export interface Payloads {
  pair: { source: FileInput; translation: FileInput };
  track: FileInput;
  analyze: ReviewInput;
  import: Uint8Array;
  package: Session;
  report: Session;
  corrected: { document: SourceDocument; edits: ReviewInput["edits"] };
  recovery: Session;
}
export interface Results {
  pair: Session;
  track: SourceDocument;
  analyze: Analysis;
  import: { session: Session; warnings: string[]; creatorVersion: string };
  package: Uint8Array;
  report: string;
  corrected: Uint8Array;
  recovery: Session;
}
export interface Request {
  requestId: number;
  revision: number;
  kind: keyof Payloads;
  payload: Payloads[keyof Payloads];
}
export interface Response {
  requestId: number;
  revision: number;
  ok: boolean;
  result?: Results[keyof Results];
  error?: string;
}
