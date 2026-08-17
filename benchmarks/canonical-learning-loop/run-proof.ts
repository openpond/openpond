import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCanonicalLearningLoopProof } from "./proof.js";

const output = path.resolve(
  "benchmarks/canonical-learning-loop/evidence/canonical-learning-loop-proof.json",
);
const { evidence } = runCanonicalLearningLoopProof();
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${output}\n${evidence.contentHash}\n`);
