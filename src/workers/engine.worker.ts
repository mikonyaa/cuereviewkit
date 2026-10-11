import { parseDocument, serializeCorrected } from "../formats/source-document";
import { createSession, analyze } from "../review/engine";
import { exportPackage, importPackage } from "../package";
import { renderReport } from "../package/report";
import type { Request, Response, Payloads } from "./protocol";
self.onmessage = async (event: MessageEvent<Request>) => {
  const { requestId, revision, kind, payload } = event.data;
  try {
    let result: Response["result"];
    if (kind === "pair") {
      const p = payload as Payloads["pair"];
      result = await createSession(
        await parseDocument(
          p.source.bytes,
          p.source.filename,
          "source",
          p.source.mime,
        ),
        await parseDocument(
          p.translation.bytes,
          p.translation.filename,
          "translation",
          p.translation.mime,
        ),
      );
    } else if (kind === "track") {
      const p = payload as Payloads["track"];
      result = await parseDocument(p.bytes, p.filename, p.role, p.mime);
    } else if (kind === "analyze")
      result = await analyze(payload as Payloads["analyze"]);
    else if (kind === "import")
      result = await importPackage(payload as Payloads["import"]);
    else if (kind === "package")
      result = await exportPackage(payload as Payloads["package"]);
    else if (kind === "report")
      result = renderReport(payload as Payloads["report"]);
    else if (kind === "corrected") {
      const p = payload as Payloads["corrected"];
      result = await serializeCorrected(p.document, p.edits);
    } else {
      const p = payload as Payloads["recovery"];
      const source = await parseDocument(
          p.source.bytes,
          p.source.filename,
          "source",
          p.source.mime,
        ),
        translation = await parseDocument(
          p.translation.bytes,
          p.translation.filename,
          "translation",
          p.translation.mime,
        );
      if (
        source.byteHash !== p.source.byteHash ||
        translation.byteHash !== p.translation.byteHash
      )
        throw new Error("Recovery original hash mismatch.");
      const input = { ...p, source, translation };
      const analysis = await analyze(input);
      result = { ...input, analysis };
    }
    self.postMessage({
      requestId,
      revision,
      ok: true,
      result,
    } satisfies Response);
  } catch (error) {
    self.postMessage({
      requestId,
      revision,
      ok: false,
      error: error instanceof Error ? error.message : "Worker failed.",
    } satisfies Response);
  }
};
