import type { Page } from "@playwright/test";

export async function installRepeatedSessionIdentity(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        let handler: ((event: MessageEvent) => void) | null = null;
        Object.defineProperty(this, "onmessage", {
          get: () => handler,
          set: (value) => {
            handler = value;
          },
        });
        this.addEventListener("message", (event) => {
          // Keep real engine output; control only the non-semantic runtime UUID.
          const result = event.data.result;
          if (event.data.ok && result && typeof result === "object") {
            if (result.session)
              result.session.id = "10000000-0000-4000-8000-000000000001";
            else if (typeof result.id === "string")
              result.id = "10000000-0000-4000-8000-000000000001";
          }
          handler?.(event);
        });
      }
    };
  });
}

declare global {
  interface Window {
    reviewGate: {
      mode: "hold" | "error" | null;
      waiting: boolean;
      release: (() => void) | null;
    };
  }
}

export async function installWorkerGate(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.reviewGate = { mode: null, waiting: false, release: null };
    window.Worker = class extends NativeWorker {
      private kind = "";
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        let handler: ((event: MessageEvent) => void) | null = null;
        Object.defineProperty(this, "onmessage", {
          get: () => handler,
          set: (value) => {
            handler = value;
          },
        });
        this.addEventListener("message", (event) => {
          const gate = window.reviewGate;
          if (this.kind === "analyze" && gate.mode) {
            const mode = gate.mode;
            gate.mode = null;
            if (mode === "hold") {
              // Hold an actual worker result, including after terminate().
              gate.waiting = true;
              gate.release = () => {
                gate.waiting = false;
                handler?.(event);
              };
            } else {
              this.dispatchEvent(
                new ErrorEvent("error", {
                  message: "Synthetic worker failure",
                }),
              );
            }
          } else handler?.(event);
        });
      }
      postMessage(message: { kind: string }) {
        this.kind = message.kind;
        super.postMessage(message);
      }
    };
  });
}
