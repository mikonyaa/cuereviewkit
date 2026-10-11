import { test as base, expect } from "@playwright/test";
import { spawn } from "node:child_process";
export const test = base.extend<object, { appUrl: string }>({
  appUrl: [
    async ({ browserName }, use) => {
      void browserName;
      const existing = process.env.CUEREVIEW_URL;
      if (existing) {
        await use(existing);
        return;
      }
      const child = spawn(
        process.execPath,
        ["scripts/serve.mjs", "--port", "0"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Static server startup timed out.")),
          10_000,
        );
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          if (output.includes("\n")) {
            clearTimeout(timer);
            resolve(JSON.parse(output.trim().split("\n")[0]).url);
          }
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code) reject(new Error("Server failed " + code));
        });
      });
      try {
        await use(url);
      } finally {
        child.kill("SIGTERM");
      }
    },
    { scope: "worker" },
  ],
});
export { expect };
