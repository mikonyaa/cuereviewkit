import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const zip = await readFile("artifacts/CueReviewKit-0.1.0-web.zip");
const versions = Object.fromEntries(
  await Promise.all(
    ["vite", "typescript", "@playwright/test", "fflate"].map(async (name) => [
      name,
      JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8"))
        .version,
    ]),
  ),
);
await writeFile(
  "artifacts/build-origin.json",
  JSON.stringify(
    {
      version: pkg.version,
      sourceCommit:
        process.env.GITHUB_SHA ||
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      buildOrigin: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
      ciRunUrl: process.env.GITHUB_ACTIONS
        ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
      node: process.version,
      npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
      tools: versions,
      archiveSha256: createHash("sha256").update(zip).digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
