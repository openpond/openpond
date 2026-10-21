import type { ImmutableAssetRef } from "@openpond/harness";
import { decodeTasksetPackageFile, type TasksetPackage } from "./taskset-package-contracts.js";

/** Resolve private module imports without running or rewriting verifier code.
 * Only original, hash-verified package assets cross the grading boundary.
 */
export async function qualificationVerifierAssets(source: TasksetPackage, entry: ImmutableAssetRef): Promise<ImmutableAssetRef[]> {
  const [{ isBuiltin }, { posix }, { build }] = await Promise.all([
    import("node:module"), import("node:path"), import("esbuild"),
  ]);
  const files = new Map(source.files.map(file => [file.asset.path, file]));
  const selected = new Map<string, ImmutableAssetRef>();
  await build({
    entryPoints: [entry.path], bundle: true, write: false, platform: "node", format: "esm",
    treeShaking: false, logLevel: "silent",
    plugins: [{ name: "qualification-private-modules", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.kind !== "entry-point" && isBuiltin(args.path)) return { path: args.path, external: true };
        if (args.kind !== "entry-point" && !args.path.startsWith("./") && !args.path.startsWith("../")) {
          throw new Error(`Qualification verifier import must be a declared relative module or Node builtin: ${args.path}.`);
        }
        const path = args.kind === "entry-point" ? args.path : posix.normalize(posix.join(posix.dirname(args.importer), args.path));
        const file = files.get(path);
        if (!file || file.asset.visibility !== "verifier" || !/\.[cm]?js$/.test(path)) {
          throw new Error(`Qualification verifier dependency requires a declared verifier-visible JavaScript asset: ${path}.`);
        }
        return { path, namespace: "qualification-private-modules" };
      });
      builder.onLoad({ filter: /.*/, namespace: "qualification-private-modules" }, args => {
        const file = files.get(args.path)!;
        selected.set(file.asset.id, file.asset);
        return { contents: new TextDecoder("utf-8", { fatal: true }).decode(decodeTasksetPackageFile(file)), loader: "js" };
      });
    } }],
  });
  return [...selected.values()].sort((left, right) => left.path.localeCompare(right.path));
}
