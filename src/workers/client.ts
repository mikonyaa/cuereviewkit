import type { Payloads, Results, Response } from "./protocol";
interface WorkerLike {
  onmessage: ((event: MessageEvent<Response>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}
export class EngineClient {
  private worker: WorkerLike | null = null;
  private requestId = 0;
  private pending: {
    requestId: number;
    revision: number;
    resolve: (value: Results[keyof Results]) => void;
    reject: (error: Error) => void;
  } | null = null;
  constructor(
    private factory: () => WorkerLike = () =>
      new Worker(new URL("./engine.worker.ts", import.meta.url), {
        type: "module",
      }),
  ) {}
  cancel() {
    this.worker?.terminate();
    this.worker = null;
    this.pending?.reject(
      new Error("Calculation cancelled. Current review was kept."),
    );
    this.pending = null;
  }
  run<K extends keyof Payloads>(
    kind: K,
    payload: Payloads[K],
    revision: number,
  ): Promise<Results[K]> {
    this.cancel();
    const worker = this.factory();
    this.worker = worker;
    const requestId = ++this.requestId;
    return new Promise<Results[K]>((resolve, reject) => {
      this.pending = {
        requestId,
        revision,
        resolve: (v) => resolve(v as Results[K]),
        reject,
      };
      worker.onmessage = ({ data }) => {
        const p = this.pending;
        if (
          !p ||
          p.requestId !== data.requestId ||
          p.revision !== data.revision ||
          worker !== this.worker
        )
          return;
        this.pending = null;
        if (data.ok) p.resolve(data.result!);
        else p.reject(new Error(data.error));
        worker.terminate();
        if (this.worker === worker) this.worker = null;
      };
      worker.onerror = (e) => {
        if (worker !== this.worker) return;
        this.pending?.reject(new Error(e.message || "Worker unavailable."));
        this.pending = null;
        worker.terminate();
        this.worker = null;
      };
      worker.postMessage({ requestId, revision, kind, payload });
    });
  }
}
