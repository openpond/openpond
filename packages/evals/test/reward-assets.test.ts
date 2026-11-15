import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { compileRewardAuthoring, createLearningTextAsset, rewardAuthoringFields, verifyLearningTextAsset } from "../src/learning/index.js";
import { executeJavaScriptVerifier } from "../src/javascript-verifier.js";

// Failure story: independent training/evaluation Rewards, or two revisions of
// one Reward, must survive export into the same directory without overwriting
// either verifier or its fixtures. Checks of either Reward alone miss this.
test("authored reward revisions coexist with an immutable evaluator on disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reward-assets-"));
  try {
    const fixture = (id: string, score: string) => ({ id, name: id, input: "{}", output: "{}", expectedOutput: "{}",
      evaluatorContext: "", artifactRefs: [], runtimeEventRefs: [], infrastructureError: "", expectedStatus: "scored" as const,
      minimumScore: score, maximumScore: score, expectedPassed: "false" as const });
    const fields = { ...rewardAuthoringFields(null, null), kind: "custom_verifier" as const, name: "Training reward",
      code: "export function verify() { return {score: 0.25, passed: false, feedback: 'Checked'}; }", fixtures: [fixture("first", "0.25")] };
    const first = compileRewardAuthoring({ id: "training-reward", fields, base: null });
    const second = compileRewardAuthoring({ id: first.reward.id, base: first.reward,
      fields: { ...fields, code: "export function verify() { return {score: 0.75, passed: false, feedback: 'Checked'}; }", fixtures: [fixture("second", "0.75")] } });
    const evaluation = createLearningTextAsset({ text: "export function verify() { return {score: 0, passed: false, feedback: 'Checked'}; }",
      path: "verifier.mjs", visibility: "verifier", mediaType: "application/javascript" });
    const assets = [...first.assets, ...second.assets, evaluation];
    const paths = new Map<string, string>();
    for (const asset of assets) {
      const prior = paths.get(asset.asset.path);
      if (prior && prior !== asset.id) throw new Error("Asset path collision");
      paths.set(asset.asset.path, asset.id);
      const file = join(directory, asset.asset.path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, verifyLearningTextAsset(asset, asset.asset));
      expect(asset.asset.visibility).toBe("verifier");
    }
    for (const [compiled, score] of [[first, 0.25], [second, 0.75]] as const) {
      if (compiled.reward.implementation.kind !== "custom_verifier") throw new Error("Verifier missing");
      const source = await readFile(join(directory, compiled.reward.implementation.verifierRef.path), "utf8");
      expect(await executeJavaScriptVerifier({ source, value: {}, timeoutMs: 1_000 })).toMatchObject({ score, passed: false });
      const fixtures = JSON.parse(await readFile(join(directory, compiled.reward.fixtureSetRef!.path), "utf8"));
      expect(fixtures[0].minimumScore).toBe(String(score));
    }
    expect(await readFile(join(directory, evaluation.asset.path), "utf8")).toBe(evaluation.text);
    expect(compileRewardAuthoring({ id: first.reward.id, fields, base: null })).toEqual(first);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
