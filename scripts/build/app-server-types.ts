import { readdir, readFile, writeFile } from "node:fs/promises";
import { generateDtsBundle } from "dts-bundle-generator";
import { fromRoot } from "./shared-esbuild.js";

// The public npm entry must not leak references to private workspace packages.
const inlinedLibraries: string[] = [];
for (const directory of ["apps", "packages"]) {
  for (const entry of await readdir(fromRoot(directory), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = await readFile(fromRoot(directory, entry.name, "package.json"), "utf8").catch(() => null);
    if (manifest) inlinedLibraries.push(JSON.parse(manifest).name);
  }
}
const [declarations] = generateDtsBundle([{
  filePath: fromRoot("apps/cli/src/app-server.ts"),
  libraries: { inlinedLibraries, importedLibraries: ["zod", "node", "node:stream", "stream"], allowedTypesLibraries: [] },
  output: { exportReferencedTypes: false, noBanner: true },
}], { preferredConfigPath: fromRoot("apps/cli/tsconfig.json") });
if (!declarations || /["'](?:@openpond\/|openpond-sdk)/.test(declarations)) {
  throw new Error("App-server declarations contain unpublished workspace imports.");
}
await writeFile(fromRoot("apps/cli/dist/app-server.d.ts"), declarations);
