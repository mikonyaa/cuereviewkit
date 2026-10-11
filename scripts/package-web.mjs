import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";
const pkg = JSON.parse(await readFile("package.json", "utf8")),
  root = "artifacts/web-package";
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await cp("dist", path.join(root, "app"), { recursive: true });
await cp("scripts/serve.mjs", path.join(root, "serve.mjs"));
for (const name of ["README-OFFLINE.md", "LICENSE", "THIRD_PARTY_NOTICES.md"])
  await cp(name, path.join(root, name));
await cp("examples", path.join(root, "examples"), { recursive: true });
const files = Object.create(null);
async function collect(dir, prefix = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink())
      throw new Error("Package symlinks are forbidden.");
    if (entry.isDirectory())
      await collect(path.join(dir, entry.name), name + "/");
    else
      files[name] = new Uint8Array(await readFile(path.join(dir, entry.name)));
  }
}
await collect(root);
const bytes = zipSync(files, { level: 6 });
const archive = `artifacts/CueReviewKit-${pkg.version}-web.zip`;
await writeFile(archive, bytes);
await writeFile(
  "artifacts/zip-files.json",
  JSON.stringify(Object.keys(files).sort(), null, 2) + "\n",
);
console.log(
  JSON.stringify({
    archive,
    files: Object.keys(files).length,
    bytes: bytes.length,
  }),
);
