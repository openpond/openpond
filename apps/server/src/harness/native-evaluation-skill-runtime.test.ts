import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { sha256, type ImmutableAssetRef } from "@openpond/harness";
import type { ProfileSkillRuntime } from "../runtime/hosted-turn/native-tools-runtime.js";
import { materializeNativeEvaluationSkills } from "./native-evaluation-skill-runtime.js";

// Native Python imports previously wrote into frozen releases. Exercise an
// actual import, private-file exclusion, and source/copy tampering together.
test("native skill execution leaves frozen source intact and admits only sealed public resources", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evaluation-skills-"));
  const bundlePath = path.join(root, "release"), cwd = path.join(root, "task");
  const prefix = "skills/quote", files: ImmutableAssetRef[] = [];
  const skillText = "Released instructions", script = "VALUE = 7\n";
  async function asset(relative: string, bytes: string, visibility: ImmutableAssetRef["visibility"]) {
    const target = path.join(bundlePath, "source", relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    files.push({ id: `asset-${files.length}`, path: relative, contentHash: sha256(Buffer.from(bytes)),
      sizeBytes: Buffer.byteLength(bytes), mediaType: "text/plain", visibility });
  }
  try {
    await fs.mkdir(cwd);
    await asset(`${prefix}/SKILL.md`, skillText, "policy");
    await asset(`${prefix}/scripts/quote.py`, script, "policy");
    await asset(`${prefix}/private/gold.json`, "private gold", "verifier");
    await fs.writeFile(path.join(bundlePath, "source", prefix, "unlisted-cache"), "cache");
    const runtime: ProfileSkillRuntime = {
      profileSourcePath: path.join(bundlePath, "source"),
      skills: [{ name: "quote", description: "Quote", path: `${prefix}/SKILL.md`, scope: "profile", enabled: true,
        sourcePath: path.join(bundlePath, "source"), charCount: skillText.length, sourceHash: files[0]!.contentHash,
        validationStatus: "valid", validationMessages: [], resourceFiles: ["scripts/quote.py"] }],
      readSkill: async () => ({ name: "quote", description: "Quote", body: skillText, path: `${prefix}/SKILL.md`,
        sourceHash: files[0]!.contentHash, charCount: skillText.length,
        packagePath: path.join(bundlePath, "source", prefix), resourceFiles: ["scripts/quote.py"] }),
    };
    const input = { cwd, runtime, release: { bundlePath, harnessRelease: { files } } };
    const admitted = await materializeNativeEvaluationSkills(input);
    const read = await admitted.readSkill!("quote");
    expect(read.packagePath!.startsWith(`${cwd}${path.sep}`)).toBe(true);
    expect(read.resourceFiles).toEqual(["scripts/quote.py"]);
    await expect(fs.access(path.join(read.packagePath!, "private/gold.json"))).rejects.toThrow();
    await expect(fs.access(path.join(read.packagePath!, "unlisted-cache"))).rejects.toThrow();
    const result = await promisify(execFile)("python3", ["-c", "import quote; print(quote.VALUE)"],
      { cwd: path.join(read.packagePath!, "scripts"), env: { PATH: process.env.PATH }, timeout: 5000 });
    expect(result.stdout.trim()).toBe("7");
    await expect(fs.access(path.join(read.packagePath!, "scripts/__pycache__"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(bundlePath, "source", prefix, "scripts/__pycache__"))).rejects.toThrow();
    await fs.rm(path.join(read.packagePath!, "scripts/quote.py"));
    await fs.writeFile(path.join(read.packagePath!, "scripts/quote.py"), "VALUE = 8\n");
    await expect(admitted.readSkill!("quote")).rejects.toThrow("released bytes");
    const releasedScript = path.join(bundlePath, "source", prefix, "scripts/quote.py");
    expect(await fs.readFile(releasedScript, "utf8")).toBe(script);
    await fs.writeFile(releasedScript, "changed");
    await expect(materializeNativeEvaluationSkills(input)).rejects.toThrow("released bytes");
    await fs.rm(releasedScript);
    await fs.symlink(path.join(bundlePath, "source", prefix, "private/gold.json"), releasedScript);
    await expect(materializeNativeEvaluationSkills(input)).rejects.toThrow("escaped");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
