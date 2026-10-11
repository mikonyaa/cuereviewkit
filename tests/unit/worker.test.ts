import { expect, it } from "vitest";
import { EngineClient } from "../../src/workers/client";
import type { Response } from "../../src/workers/protocol";
it("request/revision races cannot overwrite new data; cancel terminates the actual worker", async () => {
  const workers: {
    onmessage: ((event: MessageEvent<Response>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    postMessage: (m: unknown) => void;
    terminate: () => void;
    terminated: boolean;
    sent: unknown;
  }[] = [];
  const client = new EngineClient(() => {
    const w = {
      onmessage: null as ((event: MessageEvent<Response>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      terminated: false,
      sent: null as unknown,
      postMessage(m: unknown) {
        this.sent = m;
      },
      terminate() {
        this.terminated = true;
      },
    };
    workers.push(w);
    return w;
  });
  const first = client
    .run("import", new Uint8Array(), 1)
    .catch((e) => e.message);
  const second = client.run("import", new Uint8Array(), 2);
  expect(await first).toContain("cancelled");
  expect(workers[0].terminated).toBe(true);
  workers[0].onmessage!(
    new MessageEvent("message", {
      data: { requestId: 1, revision: 1, ok: true, result: "old" as never },
    }),
  );
  workers[1].onmessage!(
    new MessageEvent("message", {
      data: {
        requestId: 2,
        revision: 1,
        ok: true,
        result: "wrong revision" as never,
      },
    }),
  );
  workers[1].onmessage!(
    new MessageEvent("message", {
      data: { requestId: 2, revision: 2, ok: true, result: "new" as never },
    }),
  );
  expect(await second).toBe("new");
  expect(workers[1].terminated).toBe(true);
  const third = client
    .run("import", new Uint8Array(), 3)
    .catch((e) => e.message);
  client.cancel();
  expect(await third).toContain("cancelled");
  expect(workers[2].terminated).toBe(true);
});
