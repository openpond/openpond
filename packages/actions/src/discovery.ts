import { promises as fs } from "node:fs";
import path from "node:path";

const ACTION_FILE = /\.(?:[cm]?[jt]s)$/i;
const IGNORED_FILE = /(?:\.d\.ts|\.test\.[cm]?[jt]s|\.spec\.[cm]?[jt]s)$/i;

export async function discoverProjectActionFiles(input: {
  projectRoot: string;
  sourceDirectory?: string;
}): Promise<{ projectRoot: string; sourceRoot: string; files: string[] }> {
  const projectRoot = path.resolve(input.projectRoot);
  const sourceRoot = path.resolve(projectRoot, input.sourceDirectory ?? "openpond/actions");
  if (!isWithin(projectRoot, sourceRoot)) {
    throw new Error("Project Action source directory must stay inside the Project root.");
  }
  const stats = await fs.stat(sourceRoot).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`Project Action source directory does not exist: ${sourceRoot}`);
  }
  const files = await walk(sourceRoot);
  const actions = files
    .filter((file) => ACTION_FILE.test(file) && !IGNORED_FILE.test(file))
    .map((file) => path.relative(projectRoot, file).split(path.sep).join("/"))
    .sort();
  if (actions.length === 0) {
    throw new Error(`No Project Action files were found under ${sourceRoot}.`);
  }
  return { projectRoot, sourceRoot, files: actions };
}

async function walk(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
