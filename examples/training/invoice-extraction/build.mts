import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInvoiceStarterPackage } from "./package.js";

const packageValue = createInvoiceStarterPackage();
const output = resolve(process.argv[2] ?? "artifacts/model-starters/invoice-extractor.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(packageValue, null, 2)}\n`);
console.log(JSON.stringify({ output, id: packageValue.starter.id, contentHash: packageValue.starter.contentHash, tasks: packageValue.taskset.tasks.length, splits: Object.fromEntries(["train", "validation", "frozen_eval"].map(split => [split, packageValue.taskset.tasks.filter(task => task.split === split).length])) }));
