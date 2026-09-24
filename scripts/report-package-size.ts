// Built-in Node APIs only: this tooling also measures older base revisions that
// do not yet have these scripts, without installing the head's dependencies.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkPackageContents } from "./distribution/package-policy.ts";
import { collectSizeSnapshot, readSizeSnapshot } from "./distribution/size-snapshot.ts";
import { compareSizes } from "./distribution/size-comparison.ts";

const { values } = parseArgs({ options: {
  root: { type: "string" }, output: { type: "string" }, head: { type: "string" },
  base: { type: "string" }, "check-contents": { type: "boolean" }, "snapshot-only": { type: "boolean" },
} });
const head = values.head ? await readSizeSnapshot(values.head) : await collectSizeSnapshot(path.resolve(values.root ?? "."));
if (values["check-contents"]) await checkPackageContents(path.resolve(values.root ?? "."), head.files);
if (values.output) {
  await mkdir(path.dirname(values.output), { recursive: true });
  await writeFile(values.output, JSON.stringify(head, null, 2) + "\n");
}
if (!values["snapshot-only"]) {
  const base = values.base ? await readSizeSnapshot(values.base) : undefined;
  const report = compareSizes(head, base);
  console.log(report.markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report.markdown);
  for (const warning of report.warnings) console.warn(`::warning title=Package size growth::${warning}`);
}
