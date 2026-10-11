import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256 } from "@openpond/harness";
import type { ProfileSkillRuntime } from "../runtime/hosted-turn/native-tools-runtime.js";
import type { LocalHarnessReleaseRecord } from "../store/store-harness-release-record.js";

/** Native tools execute skill resources from task scratch, never the immutable
 * release. Only declared public bytes are copied, not private or cached files. */
export async function materializeNativeEvaluationSkills(input: {
  cwd: string;
  release: { bundlePath: string; harnessRelease: Pick<LocalHarnessReleaseRecord["harnessRelease"], "files"> };
  runtime: ProfileSkillRuntime;
}): Promise<ProfileSkillRuntime> {
  if (!input.runtime.readSkill || !input.runtime.skills.length) return input.runtime;
  const sourceRoot = await fs.realpath(path.join(input.release.bundlePath, "source"));
  const prefixes = input.runtime.skills.map(skill => `${path.posix.dirname(skill.path)}/`);
  const privateHashes = new Set(input.release.harnessRelease.files
    .filter(asset => asset.visibility !== "policy").map(asset => asset.contentHash));
  const assets = input.release.harnessRelease.files.filter(asset => asset.visibility === "policy"
    && !privateHashes.has(asset.contentHash) && prefixes.some(prefix => asset.path.startsWith(prefix)));
  const root = await fs.mkdtemp(path.join(await fs.realpath(input.cwd), ".profile-policy-"));
  async function verify(rootPath: string, asset: typeof assets[number]) {
    const absolute = path.resolve(rootPath, ...asset.path.split("/"));
    const actual = await fs.realpath(absolute);
    if (!actual.startsWith(`${rootPath}${path.sep}`) || (await fs.lstat(absolute)).isSymbolicLink()) {
      throw new Error("Evaluation skill resource escaped its declared public source.");
    }
    const bytes = await fs.readFile(actual);
    if (bytes.length !== asset.sizeBytes || sha256(bytes) !== asset.contentHash) {
      throw new Error("Evaluation skill resource differs from its released bytes.");
    }
    return bytes;
  }
  try {
    for (const asset of assets) {
      const bytes = await verify(sourceRoot, asset);
      const destination = path.resolve(root, ...asset.path.split("/"));
      if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("Invalid evaluation skill resource path.");
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o400 });
    }
    for (const skill of input.runtime.skills) {
      if (!assets.some(asset => asset.path === skill.path)) throw new Error("Evaluation skill is outside its public source closure.");
    }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
  const readSkill = input.runtime.readSkill;
  return {
    profileSourcePath: root,
    skills: input.runtime.skills.map(skill => ({ ...skill, sourcePath: root })),
    readSkill: async name => {
      const skill = input.runtime.skills.find(candidate => candidate.name === name);
      if (!skill) throw new Error("Evaluation skill is absent from its released public source.");
      const prefix = `${path.posix.dirname(skill.path)}/`;
      for (const asset of assets.filter(asset => asset.path.startsWith(prefix))) await verify(root, asset);
      const result = await readSkill(name);
      return { ...result, packagePath: path.join(root, path.posix.dirname(skill.path)),
        resourceFiles: assets.filter(asset => asset.path.startsWith(prefix) && asset.path !== skill.path)
          .map(asset => asset.path.slice(prefix.length)).sort() };
    },
  };
}
