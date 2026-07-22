import { describe, expect, test, vi } from "vitest";

import { createProfileSkillCatalogRuntime } from "../apps/server/src/runtime/hosted-turn/profile-skill-catalog-runtime";
import { resolveHostedToolRolloutFlags } from "../apps/server/src/runtime/hosted-turn/rollout";
import { baseSession } from "./helpers/byok-turn-runner-harness";

describe("third-party extension skill runtime", () => {
  test("adds installed extension skills to the harness catalog and preloads explicit invocations", async () => {
    const readExtensionSkill = vi.fn(async () => ({
      name: "deploy-check",
      description: "Check a deployment before release.",
      body: "Verify the deployment health before announcing it.",
      path: ".agents/skills/catalog/deploy-check/SKILL.md",
      sourcePath: "/tmp/extensions/github/acme/pond-skills/current",
      sourceHash: "hash-deploy",
      charCount: 120,
      packagePath: "/tmp/extensions/github/acme/pond-skills/current/.agents/skills/catalog/deploy-check",
      resourceFiles: ["scripts/check.sh"],
    }));
    const appendProfileSkillEvent = vi.fn(async () => undefined);
    const runtime = createProfileSkillCatalogRuntime({
      loadExtensionCatalog: async () => ({
        rootPath: "/tmp/extensions",
        registryPath: "/tmp/extensions/registry.json",
        error: null,
        extensions: [{
          id: "github:acme/pond-skills",
          source: "github",
          owner: "acme",
          repo: "pond-skills",
          repositoryUrl: "https://github.com/acme/pond-skills",
          requestedRef: "HEAD",
          resolvedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sourcePath: "/tmp/extensions/github/acme/pond-skills/current",
          readmePath: null,
          installedAt: "2026-07-22T12:00:00.000Z",
          updatedAt: "2026-07-22T12:00:00.000Z",
          packageHash: "package-hash",
          validationStatus: "valid",
          validationMessages: [],
          skills: [{
            name: "deploy-check",
            description: "Check a deployment before release.",
            relativePath: ".agents/skills/catalog/deploy-check/SKILL.md",
            sourcePath: "/tmp/extensions/github/acme/pond-skills/current/.agents/skills/catalog/deploy-check/SKILL.md",
            charCount: 120,
            sourceHash: "hash-deploy",
            resourceFiles: ["scripts/check.sh"],
            validationStatus: "valid",
            validationMessages: [],
          }],
        }],
      }),
      readExtensionSkill,
      appendRuntimeEvent: async () => undefined,
      nativeToolsEnabledForProvider: () => false,
      hostedToolFlags: resolveHostedToolRolloutFlags({ toolMode: "text_fallback" }),
      appendProfileSkillEvent,
      explicitProfileSkillNames: (prompt) => [...prompt.matchAll(/\$([a-z0-9-]+)/g)].map((match) => match[1]!),
      profileSkillBodyFromReadResult: (skill) => skill,
      throwIfInterrupted: () => undefined,
    });
    const session = baseSession({ id: "session_extension_skill" });
    const catalog = await runtime.loadProfileSkillRuntime({ session, turnId: "turn_extension_skill" });

    expect(catalog.skills).toEqual([
      expect.objectContaining({
        name: "deploy-check",
        enabled: true,
        path: ".agents/skills/catalog/deploy-check/SKILL.md",
      }),
    ]);
    const loaded = await runtime.preloadExplicitProfileSkills({
      session,
      turnId: "turn_extension_skill",
      prompt: "Use $deploy-check before we announce the release.",
      runtime: catalog,
      signal: new AbortController().signal,
    });
    expect(loaded).toEqual([
      expect.objectContaining({
        name: "deploy-check",
        body: expect.stringContaining("deployment health"),
        resourceFiles: ["scripts/check.sh"],
      }),
    ]);
    expect(readExtensionSkill).toHaveBeenCalledWith("deploy-check");
    expect(appendProfileSkillEvent).toHaveBeenCalledTimes(2);
  });
});
