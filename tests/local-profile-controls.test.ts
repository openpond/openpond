import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  loadGlobalConfig,
  saveConfig,
  type LocalOpenPondProfileCheckStatus,
  type LocalOpenPondProfilePushStatus,
} from "../packages/cloud/src/config";
import { emptyOpenPondProfileState } from "../packages/contracts/src";
import {
  OpenPondProfileSetupRequiredError,
  assertOpenPondProfileActionReady,
  buildOpenPondProfileSetupGate,
  hostedPublishStatusFromPayload,
  hostedRunStatusFromRunSummary,
  hostedRunSummaryFromPayload,
  hostedSourceCheckStatusFromPayload,
  initLocalProfileRepo,
  loadLocalProfileRepo,
  mergeActiveLocalProfileConfig,
  mergeProfileRepoManifestEntry,
  renameActiveProfileAgent,
  runProfileCheck,
  runProfileSdkCommand,
} from "../packages/cloud/src/profile/local-profile";
import { executeProfileSkillGoalRequest } from "../packages/cloud/src/profile/profile-skill-goal-executor";
import {
  runProfileSkillCommandFromPrompt,
  runProfileSkillGoalCommand,
} from "../packages/cloud/src/profile/profile-skill-mutations";
import {
  PROFILE_SKILL_MAX_CHARS,
  loadProfileSkills,
  readProfileSkill,
} from "../packages/cloud/src/profile/profile-skills";

describe("local profile control invariants", () => {
  test("repeat init preserves enabled agents on an existing profile manifest entry", () => {
    expect(
      mergeProfileRepoManifestEntry(
        {
          path: "profiles/default",
          defaultAgent: "default",
          enabledAgents: ["default", "phase5-reporter"],
          agentNames: { "phase5-reporter": "Phase 5 Reporter" },
        },
        "profiles/default"
      )
    ).toEqual({
      path: "profiles/default",
      defaultAgent: "default",
      enabledAgents: ["default", "phase5-reporter"],
      agentNames: { "phase5-reporter": "Phase 5 Reporter" },
    });
  });

  test("renames an active profile Agent without changing its stable ID", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-profile-agent-name-")
    );
    const originalConfig = await loadGlobalConfig();
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      await initLocalProfileRepo({ repoPath, profile: "default" });

      const renamed = await renameActiveProfileAgent(
        "default",
        "Research Assistant"
      );
      expect(renamed.agents).toContainEqual(
        expect.objectContaining({
          id: "default",
          name: "Research Assistant",
        })
      );

      const manifestPath = path.join(repoPath, "openpond-profile.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        profiles: Record<string, { agentNames?: Record<string, string> }>;
      };
      expect(manifest.profiles.default?.agentNames).toEqual({
        default: "Research Assistant",
      });

      const reset = await renameActiveProfileAgent("default", "default");
      expect(reset.agents).toContainEqual(
        expect.objectContaining({
          id: "default",
          name: "default",
        })
      );
      const resetManifest = JSON.parse(
        await readFile(manifestPath, "utf8")
      ) as {
        profiles: Record<string, { agentNames?: Record<string, string> }>;
      };
      expect(resetManifest.profiles.default?.agentNames).toBeUndefined();
    } finally {
      await saveConfig(originalConfig);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("repeat init enables the existing default agent when enabledAgents is missing", () => {
    expect(
      mergeProfileRepoManifestEntry(
        {
          path: "profiles/support",
          defaultAgent: "support",
        },
        "profiles/support"
      )
    ).toEqual({
      path: "profiles/support",
      defaultAgent: "support",
      enabledAgents: ["support"],
    });
  });

  test("loading the same profile preserves local check and hosted push status", () => {
    const lastCheck: LocalOpenPondProfileCheckStatus = {
      command: "eval",
      status: "passed",
      checkedAt: "2026-06-29T16:58:06.861Z",
      exitCode: 0,
      sourceHead: "f33a352dfbce0f5f93e29f29df2dde0258b69ed8",
    };
    const lastPush: LocalOpenPondProfilePushStatus = {
      status: "pushed",
      pushedAt: "2026-06-28T18:13:28.572Z",
      teamId: "team_123",
      projectId: "project_123",
      localHead: "f33a352dfbce0f5f93e29f29df2dde0258b69ed8",
      hostedHead: "5287f494a394f2d3e265382cafb7b8b10d7d4b05",
      sourceRef: "main",
      promotionStatus: "hosted_run_pending",
      hostedRunStatus: "running",
      hostedRunAgentId: "agent_123",
      hostedRunId: "run_123",
      hostedRunAt: "2026-06-28T18:14:28.572Z",
      hostedSourceMaterialization: {
        status: "uploaded",
        agentId: "agent_123",
        projectId: "project_123",
        sourceRoot: "/workspace/profile-repo/profiles/default/agents/agent_123",
        sourceRef: "main",
        sourceCommitSha: "source_sha_123",
        manifestHash: "manifest_hash_123",
        manifestPath: "openpond.yaml",
        manifestSyncedAt: "2026-06-28T18:14:00.572Z",
        fileCount: 12,
        totalBytes: 3456,
        generatedManifestPath: ".openpond/openpond-manifest.preview.yaml",
        synthesizedOpenPondYaml: true,
        uploadMetadataPath: ".openpond/source-upload-metadata.json",
        setupCommands: ["pnpm install"],
        validationCommands: ["openpond-agent validate"],
        materializedAt: "2026-06-28T18:14:01.572Z",
      },
      hostedSourceCheck: {
        status: "requested",
        agentId: "agent_123",
        workItemId: "work_item_123",
        deployPlanStatus: "ready",
        canRun: true,
        canDeploy: true,
        sourceRef: "main",
        sourceCommitSha: "5287f494a394f2d3e265382cafb7b8b10d7d4b05",
        manifestHash: "manifest_hash_123",
        setupCommands: ["pnpm install"],
        validationCommands: ["openpond-agent validate"],
        requiredChecks: ["openpond-agent validate"],
        evalNames: ["support-items"],
        blockedReasons: [],
        staleReasons: [],
        runtimeId: "runtime_123",
        sandboxId: "sandbox_123",
      },
      hostedPublish: {
        status: "published",
        agentId: "agent_123",
        snapshotId: "snapshot_123",
        sourceRef: "main",
        sourceCommitSha: "5287f494a394f2d3e265382cafb7b8b10d7d4b05",
        manifestHash: "manifest_hash_123",
        buildStatus: "passed",
        validationStatus: "passed",
        evalStatus: "passed",
        publishedAt: "2026-06-28T18:14:20.572Z",
      },
      hostedRun: {
        status: "running",
        agentId: "agent_123",
        runId: "run_123",
        runtimeId: "runtime_123",
        sandboxId: "sandbox_123",
        sourceRef: "main",
        sourceCommitSha: "5287f494a394f2d3e265382cafb7b8b10d7d4b05",
        manifestHash: "manifest_hash_123",
        setupGateStatus: "ready",
        setupRequirementRefs: [
          "action_catalog:agent_123.chat:integration:fixtures",
        ],
        traceArtifactRefs: ["artifacts/trace.jsonl"],
      },
    };

    expect(
      mergeActiveLocalProfileConfig(
        {
          repoPath: "/workspace/profile-repo",
          profile: "default",
          mode: "local",
          lastCheck,
          lastPush,
        },
        "/workspace/profile-repo",
        "default"
      )
    ).toEqual({
      repoPath: "/workspace/profile-repo",
      profile: "default",
      mode: "local",
      lastCheck,
      lastPush,
    });
  });

  test("loading a different profile drops stale check and push status", () => {
    expect(
      mergeActiveLocalProfileConfig(
        {
          repoPath: "/workspace/profile-repo",
          profile: "default",
          mode: "local",
          lastPush: {
            status: "pushed",
            pushedAt: "2026-06-28T18:13:28.572Z",
            projectId: "project_123",
          },
        },
        "/workspace/profile-repo",
        "support"
      )
    ).toEqual({
      repoPath: "/workspace/profile-repo",
      profile: "support",
      mode: "local",
    });
  });

  test("extracts hosted promotion evidence from source check, publish, and run payloads", () => {
    const sourceCheck = hostedSourceCheckStatusFromPayload({
      agentId: "agent_123",
      status: "requested",
      checkResult: {
        workItem: { id: "work_item_123" },
        deployPlan: {
          status: "ready",
          canRun: true,
          canDeploy: true,
          blockedReasons: [],
          staleReasons: [],
          source: {
            sourceRef: "main",
            sourceCommitSha: "sha_123",
            manifestHash: "manifest_hash_123",
            manifestPath: "openpond.yaml",
          },
          checks: {
            setupCommands: ["pnpm install"],
            validationCommands: ["openpond-agent validate"],
            requiredChecks: ["openpond-agent validate"],
            evalNames: ["support-items"],
          },
        },
        sourceCheckStatus: {
          latestRuntimeId: "runtime_123",
          latestSandboxId: "sandbox_123",
          traceArtifactRefs: ["artifacts/trace.jsonl"],
        },
      },
    });
    const publish = hostedPublishStatusFromPayload({
      agentId: "agent_123",
      publishResult: {
        activeManifestSnapshot: {
          id: "snapshot_123",
          sourceRef: "main",
          sourceCommitSha: "sha_123",
          manifestHash: "manifest_hash_123",
          manifestPath: "openpond.yaml",
          buildStatus: "passed",
          validationStatus: "passed",
          evalStatus: "passed",
        },
        publishedAt: "2026-07-02T12:00:00.000Z",
      },
    });
    const run = hostedRunSummaryFromPayload({
      agentId: "agent_123",
      runResult: {
        run: {
          id: "run_123",
          agentId: "agent_123",
          status: "succeeded",
          runtimeId: "runtime_123",
          sandboxId: "sandbox_123",
          runtimeSource: {
            sourceRef: "main",
            sourceCommitSha: "sha_123",
          },
          metadata: {
            sourceSummary: { manifestHash: "manifest_hash_123" },
            setupGate: {
              status: "ready",
              requirements: [{ ref: "setup:fixtures" }],
            },
            traceSummary: { artifactRefs: ["artifacts/trace.jsonl"] },
            evalSummary: { artifactRefs: ["artifacts/eval.json"] },
          },
          createdAt: "2026-07-02T12:01:00.000Z",
          completedAt: "2026-07-02T12:02:00.000Z",
        },
      },
    });

    expect(sourceCheck).toMatchObject({
      status: "requested",
      workItemId: "work_item_123",
      manifestHash: "manifest_hash_123",
      setupCommands: ["pnpm install"],
      runtimeId: "runtime_123",
      sandboxId: "sandbox_123",
    });
    expect(publish).toMatchObject({
      status: "published",
      snapshotId: "snapshot_123",
      validationStatus: "passed",
    });
    expect(run).toMatchObject({
      status: "succeeded",
      runId: "run_123",
      runtimeId: "runtime_123",
      sandboxId: "sandbox_123",
      manifestHash: "manifest_hash_123",
      setupGateStatus: "ready",
      setupRequirementRefs: ["setup:fixtures"],
    });
    expect(hostedRunStatusFromRunSummary(run)).toBe("passed");
  });

  test("discovers profile skills from profile-native skills directory", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-profile-skills-")
    );
    try {
      const sourcePath = path.join(tempRoot, "profiles", "default");
      await mkdir(path.join(sourcePath, "skills", "release-notes"), {
        recursive: true,
      });
      await writeFile(
        path.join(sourcePath, "skills", "release-notes", "SKILL.md"),
        [
          "---",
          "name: release-notes",
          "description: Draft concise release notes from profile source changes.",
          "---",
          "",
          "Write concise release notes grouped by user-facing capability.",
          "",
        ].join("\n"),
        "utf8"
      );

      const result = await loadProfileSkills(sourcePath);
      expect(result.skillCatalog).toMatchObject({
        skillCount: 1,
        stale: false,
        error: null,
      });
      expect(result.skills[0]).toMatchObject({
        name: "release-notes",
        description: "Draft concise release notes from profile source changes.",
        path: "skills/release-notes/SKILL.md",
        scope: "profile",
        enabled: true,
        validationStatus: "valid",
        validationMessages: [],
      });
      expect(result.skills[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);

      await expect(
        readProfileSkill({
          profileSourcePath: sourcePath,
          name: "release-notes",
        })
      ).resolves.toMatchObject({
        name: "release-notes",
        body: "Write concise release notes grouped by user-facing capability.",
        path: "skills/release-notes/SKILL.md",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("discovers bundled profile skill resources", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-profile-skill-invalid-")
    );
    try {
      const sourcePath = path.join(tempRoot, "profiles", "default");
      await mkdir(
        path.join(sourcePath, "skills", "release-notes", "references"),
        { recursive: true }
      );
      await writeFile(
        path.join(sourcePath, "skills", "release-notes", "SKILL.md"),
        [
          "---",
          "name: release-notes",
          "description: Draft release notes.",
          "---",
          "",
          "Write release notes.",
          "",
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(sourcePath, "skills", "release-notes", "references", "style.md"),
        "# Release-note style\n",
        "utf8",
      );

      const result = await loadProfileSkills(sourcePath);
      expect(result.skills[0]).toMatchObject({
        name: "release-notes",
        enabled: true,
        validationStatus: "valid",
        resourceFiles: ["references/style.md"],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("validates profile skill parser edge cases", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-profile-skill-edges-")
    );
    try {
      const sourcePath = path.join(tempRoot, "profiles", "default");
      await mkdir(path.join(sourcePath, "skills", "missing-frontmatter"), {
        recursive: true,
      });
      await mkdir(path.join(sourcePath, "skills", "malformed-frontmatter"), {
        recursive: true,
      });
      await mkdir(path.join(sourcePath, "skills", "oversized"), {
        recursive: true,
      });
      await mkdir(path.join(sourcePath, "skills", "bad-name"), {
        recursive: true,
      });
      await mkdir(path.join(sourcePath, "skills", "duplicate-one"), {
        recursive: true,
      });
      await mkdir(path.join(sourcePath, "skills", "duplicate-two"), {
        recursive: true,
      });
      await writeFile(
        path.join(sourcePath, "skills", "missing-frontmatter", "SKILL.md"),
        "No frontmatter here.\n",
        "utf8"
      );
      await writeFile(
        path.join(sourcePath, "skills", "malformed-frontmatter", "SKILL.md"),
        "---\nname: [unterminated\ndescription: Broken YAML\n---\n\nBroken.\n",
        "utf8"
      );
      await writeFile(
        path.join(sourcePath, "skills", "oversized", "SKILL.md"),
        [
          "---",
          "name: oversized",
          "description: Too large.",
          "---",
          "",
          "x".repeat(PROFILE_SKILL_MAX_CHARS),
          "",
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(sourcePath, "skills", "bad-name", "SKILL.md"),
        "---\nname: Bad Name\ndescription: Invalid name.\n---\n\nInvalid.\n",
        "utf8"
      );
      await writeFile(
        path.join(sourcePath, "skills", "duplicate-one", "SKILL.md"),
        "---\nname: duplicate-skill\ndescription: Duplicate one.\n---\n\nOne.\n",
        "utf8"
      );
      await writeFile(
        path.join(sourcePath, "skills", "duplicate-two", "SKILL.md"),
        "---\nname: duplicate-skill\ndescription: Duplicate two.\n---\n\nTwo.\n",
        "utf8"
      );

      const result = await loadProfileSkills(sourcePath);
      const messagesByPath = new Map(
        result.skills.map((skill) => [
          skill.path,
          skill.validationMessages.join("\n"),
        ])
      );

      expect(
        messagesByPath.get("skills/missing-frontmatter/SKILL.md")
      ).toContain("must start with YAML frontmatter");
      expect(
        messagesByPath.get("skills/malformed-frontmatter/SKILL.md")
      ).toContain("frontmatter is invalid YAML");
      expect(messagesByPath.get("skills/oversized/SKILL.md")).toContain(
        `exceeds the limit of ${PROFILE_SKILL_MAX_CHARS}`
      );
      expect(messagesByPath.get("skills/bad-name/SKILL.md")).toContain(
        "Skill name must be lowercase kebab-case."
      );
      expect(messagesByPath.get("skills/bad-name/SKILL.md")).toContain(
        "Skill name must match its directory name"
      );
      expect(messagesByPath.get("skills/duplicate-one/SKILL.md")).toContain(
        "Duplicate skill name: duplicate-skill"
      );
      expect(messagesByPath.get("skills/duplicate-two/SKILL.md")).toContain(
        "Duplicate skill name: duplicate-skill"
      );
      expect(
        result.skills.every(
          (skill) => skill.validationStatus === "error" && !skill.enabled
        )
      ).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("profile state includes skills and skill diff changes", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-profile-skill-state-")
    );
    const originalConfig = await loadGlobalConfig();
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      await initLocalProfileRepo({ repoPath, profile: "default" });
      const sourcePath = path.join(repoPath, "profiles", "default");
      await mkdir(path.join(sourcePath, "skills", "release-notes"), {
        recursive: true,
      });
      await writeFile(
        path.join(sourcePath, "skills", "release-notes", "SKILL.md"),
        [
          "---",
          "name: release-notes",
          "description: Draft concise release notes from profile source changes.",
          "---",
          "",
          "Write concise release notes grouped by user-facing capability.",
          "",
        ].join("\n"),
        "utf8"
      );

      const state = await loadLocalProfileRepo(repoPath, "default");
      expect(state.skills).toHaveLength(1);
      expect(state.skills[0]).toMatchObject({
        name: "release-notes",
        path: "skills/release-notes/SKILL.md",
      });
      expect(state.skillCatalog).toMatchObject({
        skillCount: 1,
        stale: false,
        error: null,
      });
      expect(state.diff.changedSkills).toEqual(["release-notes"]);
      expect(state.summary.message).toContain("skill");
    } finally {
      await saveConfig(originalConfig);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("profile state discovers Agent Eval source for Lab reuse", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-profile-eval-state-")
    );
    const originalConfig = await loadGlobalConfig();
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      await initLocalProfileRepo({ repoPath, profile: "default" });
      const evalPath = path.join(
        repoPath,
        "profiles",
        "default",
        "agent",
        "evals",
        "reply-quality.eval.ts"
      );
      await mkdir(path.dirname(evalPath), { recursive: true });
      await writeFile(evalPath, "export const evalDefinition = {};\n", "utf8");

      const state = await loadLocalProfileRepo(repoPath, "default");

      expect(state.evals).toEqual([
        {
          id: "agent/evals/reply-quality.eval.ts",
          name: "reply-quality",
          path: "agent/evals/reply-quality.eval.ts",
          agentId: "default",
          sourcePath: evalPath,
        },
      ]);
    } finally {
      await saveConfig(originalConfig);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("profile skill command lists skills and routes create/edit through goals", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-profile-skill-command-")
    );
    const originalConfig = await loadGlobalConfig();
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      await initLocalProfileRepo({ repoPath, profile: "default" });
      const skillPath = path.join(
        repoPath,
        "profiles",
        "default",
        "skills",
        "release-notes",
        "SKILL.md"
      );
      await mkdir(path.dirname(skillPath), { recursive: true });
      await writeFile(
        skillPath,
        [
          "---",
          "name: release-notes",
          "description: Draft customer-facing release notes from merged changes.",
          "---",
          "",
          "Draft concise release notes.",
          "",
        ].join("\n"),
        "utf8"
      );

      const created = await runProfileSkillCommandFromPrompt(
        "/skill create support-handoff-summaries: Draft support handoff summaries."
      );
      expect(created).toMatchObject({
        handled: false,
        action: "goal",
        workspaceCwd: repoPath,
        goal: {
          kind: "profile_skill_create",
          operation: "create",
          targetSkillName: "support-handoff-summaries",
          targetSkillPath:
            "profiles/default/skills/support-handoff-summaries/SKILL.md",
        },
      });
      expect(created?.prompt).toContain(
        "Goal: Create a profile-backed skill named support-handoff-summaries"
      );
      expect(created?.prompt).toContain(
        "Keep SKILL.md as the required entry point."
      );

      const namedFlag = await runProfileSkillCommandFromPrompt(
        "/skill create --name docker-cleanup clear Docker caches safely"
      );
      expect(namedFlag).toMatchObject({
        handled: false,
        action: "goal",
        goal: {
          kind: "profile_skill_create",
          operation: "create",
          requestedName: "docker-cleanup",
          targetSkillName: "docker-cleanup",
          targetSkillPath: "profiles/default/skills/docker-cleanup/SKILL.md",
          userObjective: "clear Docker caches safely",
        },
      });

      const plainLanguage = await runProfileSkillCommandFromPrompt(
        "/skill create a skill that cleans up docker build cache and unused images"
      );
      expect(plainLanguage).toMatchObject({
        handled: false,
        action: "goal",
        goal: {
          kind: "profile_skill_create",
          operation: "create",
          requestedName: null,
          targetSkillName: null,
          targetSkillPath: null,
          userObjective:
            "a skill that cleans up docker build cache and unused images",
        },
      });

      const conversational = await runProfileSkillCommandFromPrompt(
        "/skill can you make a reusable workflow for polishing product videos?",
      );
      expect(conversational).toMatchObject({
        handled: false,
        action: "goal",
        goal: {
          kind: "profile_skill_create",
          userObjective: "can you make a reusable workflow for polishing product videos?",
        },
      });
      if (!conversational || conversational.handled) {
        throw new Error("Expected conversational /skill request to create a profile skill goal.");
      }
      const conversationalExecution = await executeProfileSkillGoalRequest(conversational.goal);
      const conversationalSkill = await readFile(
        path.join(conversational.goal.profileSourcePath, conversationalExecution.skillPath),
        "utf8",
      );
      expect(conversationalSkill).toContain(
        "can you make a reusable workflow for polishing product videos?",
      );

      const list = await runProfileSkillCommandFromPrompt("/skill list");
      expect(list).toMatchObject({
        handled: true,
        action: "list",
      });
      expect(list?.message).toContain("release-notes");

      const updated = await runProfileSkillCommandFromPrompt(
        "/skill edit release-notes Include QA verification notes when requested."
      );
      expect(updated).toMatchObject({
        handled: false,
        action: "goal",
        workspaceCwd: repoPath,
        goal: {
          kind: "profile_skill_edit",
          operation: "edit",
          targetSkillName: "release-notes",
          targetSkillPath: "profiles/default/skills/release-notes/SKILL.md",
        },
        skill: {
          name: "release-notes",
        },
      });
      await expect(readFile(skillPath, "utf8")).resolves.not.toContain(
        "Include QA verification notes when requested."
      );

      const natural = await runProfileSkillCommandFromPrompt(
        "create a skill that helps write launch checklists"
      );
      expect(natural).toBeNull();

      const createMe = await runProfileSkillCommandFromPrompt(
        "create me a skill to do support handoff summaries"
      );
      expect(createMe).toBeNull();

      const structured = await runProfileSkillGoalCommand({
        operation: "create",
        objective: "Draft onboarding checklists.",
        skillName: "onboarding-checklists",
        source: "model_tool",
      });
      expect(structured).toMatchObject({
        handled: false,
        action: "goal",
        workspaceCwd: repoPath,
        goal: {
          kind: "profile_skill_create",
          operation: "create",
          source: "model_tool",
          targetSkillName: "onboarding-checklists",
          targetSkillPath:
            "profiles/default/skills/onboarding-checklists/SKILL.md",
        },
      });
      expect(structured?.prompt).toContain(
        "Keep SKILL.md as the required entry point."
      );

      const inferredName = await runProfileSkillGoalCommand({
        operation: "create",
        objective:
          "Docker Cleanup CommandsThese are the exact commands run each time to clear Docker build cache and unused images while leaving containers and volumes alone.docker system dfdocker builder prune -af | tail -n 1docker image prune -af | tail -n 1docker system dfNotes:docker builder prune -af clears build cache.docker image prune -af removes unused images.These commands do not remove Docker volumes.These commands do not stop or remove running containers.",
        source: "model_tool",
      });
      expect(inferredName).toMatchObject({
        handled: false,
        action: "goal",
        workspaceCwd: repoPath,
        goal: {
          kind: "profile_skill_create",
          operation: "create",
          source: "model_tool",
          requestedName: null,
          targetSkillName: null,
          targetSkillPath: null,
        },
      });
      expect(inferredName?.prompt).toContain(
        "Choose a concise lowercase kebab-case skill name"
      );
      expect(inferredName?.prompt).toContain(
        "profiles/default/skills/<skill-name>/SKILL.md"
      );
      const executed = await executeProfileSkillGoalRequest(inferredName.goal);
      expect(executed).toMatchObject({
        skillName: "docker-cleanup",
        skillPath: "skills/docker-cleanup/SKILL.md",
        invocation: "$docker-cleanup",
        validationStatus: "valid",
        goal: {
          status: "completed",
          targetSkillName: "docker-cleanup",
          targetSkillPath: "profiles/default/skills/docker-cleanup/SKILL.md",
        },
      });
      const dockerSkill = await readFile(
        path.join(
          repoPath,
          "profiles",
          "default",
          "skills",
          "docker-cleanup",
          "SKILL.md"
        ),
        "utf8"
      );
      expect(dockerSkill).toContain("docker system df");
      expect(dockerSkill).toContain("docker builder prune -af | tail -n 1");
      expect(dockerSkill).toContain("docker image prune -af | tail -n 1");
      const dockerCommandBlock = /```bash\n([\s\S]*?)\n```/
        .exec(dockerSkill)?.[1]
        .split("\n");
      expect(dockerCommandBlock).toEqual([
        "docker system df",
        "docker builder prune -af | tail -n 1",
        "docker image prune -af | tail -n 1",
        "docker system df",
      ]);
      expect(dockerSkill).toContain(
        "These commands do not remove Docker volumes."
      );
      expect(dockerSkill).toContain(
        "These commands do not stop or remove running containers."
      );

      const structuredEdit = await runProfileSkillGoalCommand({
        operation: "edit",
        objective: "Include QA verification notes when requested.",
        skillName: "release-notes",
        source: "natural_language",
      });
      expect(structuredEdit).toMatchObject({
        handled: false,
        action: "goal",
        workspaceCwd: repoPath,
        goal: {
          kind: "profile_skill_edit",
          operation: "edit",
          source: "natural_language",
          targetSkillName: "release-notes",
          targetSkillPath: "profiles/default/skills/release-notes/SKILL.md",
        },
        skill: {
          name: "release-notes",
        },
      });

      await expect(
        runProfileSkillGoalCommand({
          operation: "create",
          objective: "Draft release notes.",
          skillName: "release-notes",
          source: "model_tool",
        })
      ).rejects.toThrow("Profile skill release-notes already exists.");

      await expect(
        runProfileSkillGoalCommand({
          operation: "edit",
          objective: "Tighten the skill instructions.",
          source: "model_tool",
        })
      ).rejects.toThrow("Profile skill edit requires skillName.");

      await expect(
        runProfileSkillGoalCommand({
          operation: "edit",
          objective: "Tighten the skill instructions.",
          skillName: "missing-skill",
          source: "model_tool",
        })
      ).rejects.toThrow("Profile skill not found: missing-skill");

      await expect(
        runProfileSkillGoalCommand({
          operation: "create",
          objective: "   ",
          source: "model_tool",
        })
      ).rejects.toThrow("Describe what the skill should help with.");

      const oversized = await runProfileSkillGoalCommand({
        operation: "create",
        objective: `Oversized skill ${"details ".repeat(
          PROFILE_SKILL_MAX_CHARS
        )}`,
        source: "model_tool",
      });
      await expect(
        executeProfileSkillGoalRequest(oversized.goal)
      ).rejects.toThrow("validation failed");

      await expect(
        runProfileSkillGoalCommand(
          {
            operation: "create",
            objective: "Draft onboarding checklists.",
            source: "model_tool",
          },
          {
            loadProfileState: async () => emptyOpenPondProfileState(),
          }
        )
      ).rejects.toThrow(
        "Profile skill creation requires an active local OpenPond profile."
      );
    } finally {
      await saveConfig(originalConfig);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("profile setup gate blocks required unresolved action setup", () => {
    const gate = buildOpenPondProfileSetupGate({
      actionCatalog: [
        {
          id: "chat",
          setupRequirements: [
            {
              kind: "integration",
              name: "slack",
              required: true,
              status: "setup_required",
            },
            {
              kind: "external_service",
              name: "weather",
              required: false,
              status: "setup_required",
            },
          ],
        },
      ],
      actionId: "chat",
    });

    expect(gate).toMatchObject({
      status: "setup_required",
      requirementCount: 2,
      blockingCount: 1,
      optionalMissingCount: 1,
    });
    expect(gate.blockingRequirements).toMatchObject([
      {
        actionId: "chat",
        kind: "integration",
        label: "slack",
        status: "setup_required",
        required: true,
        blocking: true,
      },
    ]);
    let thrown: unknown;
    try {
      assertOpenPondProfileActionReady("chat", gate);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OpenPondProfileSetupRequiredError);
    if (!(thrown instanceof OpenPondProfileSetupRequiredError)) {
      throw new Error("expected structured setup-required error");
    }
    expect(thrown.code).toBe("agent_source_setup_required");
    expect(thrown.details).toMatchObject({
      error: "agent_source_setup_required",
      actionId: "chat",
      missing: ["slack"],
      setupGate: {
        status: "setup_required",
        blockingCount: 1,
      },
      blockingSetupRequirements: [
        {
          actionId: "chat",
          kind: "integration",
          label: "slack",
          required: true,
          status: "setup_required",
          blocking: true,
        },
      ],
      setupRequirements: [
        {
          actionId: "chat",
          kind: "integration",
          label: "slack",
          required: true,
          status: "setup_required",
          blocking: true,
        },
        {
          actionId: "chat",
          kind: "external_service",
          label: "weather",
          required: false,
          status: "setup_required",
          blocking: false,
        },
      ],
    });
  });

  test("profile setup gate treats optional missing rows as visible but non-blocking", () => {
    const gate = buildOpenPondProfileSetupGate({
      actionCatalog: [
        {
          id: "chat",
          setupRequirements: [
            {
              kind: "runtime_tool",
              tool: "ffmpeg",
              required: false,
              status: "setup_required",
            },
          ],
        },
      ],
      actionId: "chat",
    });

    expect(gate).toMatchObject({
      status: "ready",
      requirementCount: 1,
      blockingCount: 0,
      optionalMissingCount: 1,
    });
    expect(() => assertOpenPondProfileActionReady("chat", gate)).not.toThrow();
  });

  test("profile setup gate preserves action-scoped source upload metadata requirements", () => {
    const gate = buildOpenPondProfileSetupGate({
      actionCatalog: [
        { id: "chat", setupRequirements: [] },
        { id: "summarize", setupRequirements: [] },
      ],
      sourceSetupRequirements: [
        {
          actionId: "chat",
          kind: "env",
          name: "CHAT_TOKEN",
          required: true,
          status: "setup_required",
        },
        {
          actionId: "summarize",
          kind: "env",
          name: "SUMMARY_TOKEN",
          required: true,
          status: "setup_required",
        },
      ],
      actionId: "chat",
    });

    expect(gate).toMatchObject({
      status: "setup_required",
      requirementCount: 1,
      blockingCount: 1,
      blockingRequirements: [
        {
          source: "source_upload_metadata",
          actionId: "chat",
          kind: "env",
          label: "CHAT_TOKEN",
        },
      ],
    });
    expect(gate.requirements.map((requirement) => requirement.label)).toEqual([
      "CHAT_TOKEN",
    ]);
  });

  test("profile setup gate treats required ready rows as non-blocking", () => {
    const gate = buildOpenPondProfileSetupGate({
      actionCatalog: [
        {
          id: "chat",
          setupRequirements: [
            {
              kind: "channel",
              name: "openpond_chat",
              required: true,
              status: "ready",
              satisfied: true,
            },
            {
              kind: "volume",
              name: "committed-local-invoice-fixtures",
              required: true,
              status: "ready",
              satisfied: true,
            },
          ],
        },
      ],
      actionId: "chat",
    });

    expect(gate).toMatchObject({
      status: "ready",
      requirementCount: 2,
      blockingCount: 0,
      readyCount: 2,
    });
    expect(() => assertOpenPondProfileActionReady("chat", gate)).not.toThrow();
  });

  test("profile setup gate applies source-upload setup rows to local activation", () => {
    const gate = buildOpenPondProfileSetupGate({
      actionCatalog: [{ id: "chat", setupRequirements: [] }],
      sourceSetupRequirements: [
        {
          kind: "runtime_tool",
          tool: "libreoffice",
          required: true,
          status: "blocked",
        },
      ],
      actionId: "chat",
    });

    expect(gate).toMatchObject({
      status: "blocked",
      blockingCount: 1,
    });
    expect(gate.blockingRequirements[0]).toMatchObject({
      actionId: null,
      kind: "runtime_tool",
      label: "libreoffice",
      status: "blocked",
    });
    let thrown: unknown;
    try {
      assertOpenPondProfileActionReady("chat", gate);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OpenPondProfileSetupRequiredError);
    if (!(thrown instanceof OpenPondProfileSetupRequiredError)) {
      throw new Error("expected structured setup-required error");
    }
    expect(thrown.details).toMatchObject({
      error: "agent_source_setup_required",
      actionId: "chat",
      missing: ["libreoffice"],
      blockingSetupRequirements: [
        {
          actionId: null,
          kind: "runtime_tool",
          label: "libreoffice",
          status: "blocked",
          required: true,
          blocking: true,
        },
      ],
    });
  });

  test("profile catalog hydrates action setup requirements from source-upload metadata sidecar", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-profile-sidecar-")
    );
    const originalConfig = await loadGlobalConfig();
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      const sourcePath = path.join(repoPath, "profiles", "default");
      const agentPath = path.join(sourcePath, "agents", "invoice-agent");
      await mkdir(path.join(agentPath, ".openpond"), { recursive: true });
      await writeFile(
        path.join(repoPath, "openpond-profile.json"),
        JSON.stringify(
          {
            schema: "openpond.profileRepo.v1",
            defaultProfile: "default",
            profiles: {
              default: {
                path: "profiles/default",
                defaultAgent: "invoice-agent",
                enabledAgents: ["invoice-agent"],
              },
            },
          },
          null,
          2
        ),
        "utf8"
      );
      const actionPayload = {
        schema: "openpond.agent.actionRegistry.v1",
        actions: [
          {
            id: "check-pdf-converter-license",
            label: "Check PDF converter license",
            description: "Requires a PDF converter license secret.",
          },
        ],
      };
      await writeFile(
        path.join(agentPath, ".openpond", "agent-manifest.json"),
        JSON.stringify(actionPayload, null, 2),
        "utf8"
      );
      await writeFile(
        path.join(agentPath, ".openpond", "action-registry.json"),
        JSON.stringify(actionPayload, null, 2),
        "utf8"
      );
      await writeFile(
        path.join(agentPath, ".openpond", "source-upload-metadata.json"),
        JSON.stringify(
          {
            schema: "openpond.agent.source_upload.v1",
            setupRequirements: [
              {
                actionId: "check-pdf-converter-license",
                kind: "env",
                name: "PDF_CONVERTER_LICENSE_KEY",
                required: true,
                secret: true,
                status: "setup_required",
              },
            ],
          },
          null,
          2
        ),
        "utf8"
      );

      const state = await loadLocalProfileRepo(repoPath, "default");
      const action = state.actionCatalog.find(
        (entry) => entry.id === "check-pdf-converter-license"
      );
      expect(action?.setupRequirements).toMatchObject([
        {
          source: "source_upload_metadata",
          actionId: "check-pdf-converter-license",
          kind: "env",
          name: "PDF_CONVERTER_LICENSE_KEY",
          required: true,
          secret: true,
          status: "setup_required",
        },
      ]);
      expect(state.setupGate).toMatchObject({
        status: "setup_required",
        requirementCount: 1,
        blockingCount: 1,
        blockingRequirements: [
          {
            source: "source_upload_metadata",
            actionId: "check-pdf-converter-license",
            kind: "env",
            label: "PDF_CONVERTER_LICENSE_KEY",
          },
        ],
      });
    } finally {
      await saveConfig(originalConfig);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("profile run fails before SDK execution when required setup is unresolved", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-profile-gate-")
    );
    const originalConfig = await loadGlobalConfig();
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      const sourcePath = path.join(repoPath, "profiles", "default");
      const agentPath = path.join(sourcePath, "agents", "needs-setup");
      await mkdir(path.join(agentPath, ".openpond"), { recursive: true });
      await writeFile(
        path.join(repoPath, "openpond-profile.json"),
        JSON.stringify(
          {
            schema: "openpond.profileRepo.v1",
            defaultProfile: "default",
            profiles: {
              default: {
                path: "profiles/default",
                defaultAgent: "needs-setup",
                enabledAgents: ["needs-setup"],
              },
            },
          },
          null,
          2
        ),
        "utf8"
      );
      await writeFile(
        path.join(agentPath, ".openpond", "agent-manifest.json"),
        JSON.stringify(
          {
            schema: "openpond.agent.manifest.v1",
            actions: [
              {
                id: "chat",
                label: "Chat",
                description: "Requires unresolved setup.",
                setupRequirements: [
                  {
                    kind: "env",
                    name: "SUPPORT_API_KEY",
                    required: true,
                    status: "setup_required",
                  },
                ],
              },
            ],
          },
          null,
          2
        ),
        "utf8"
      );
      await writeFile(
        path.join(agentPath, ".openpond", "action-registry.json"),
        JSON.stringify(
          {
            schema: "openpond.agent.actionRegistry.v1",
            actions: [
              {
                id: "chat",
                label: "Chat",
                description: "Requires unresolved setup.",
                setupRequirements: [
                  {
                    kind: "env",
                    name: "SUPPORT_API_KEY",
                    required: true,
                    status: "setup_required",
                  },
                ],
              },
            ],
          },
          null,
          2
        ),
        "utf8"
      );

      const state = await loadLocalProfileRepo(repoPath, "default");
      expect(state.setupGate).toMatchObject({
        status: "setup_required",
        requirementCount: 1,
        blockingCount: 1,
      });

      let thrown: unknown;
      try {
        await runProfileSdkCommand({
          command: "run",
          args: [
            "chat",
            "--input",
            JSON.stringify({ prompt: "hello", channel: "openpond_chat" }),
          ],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(OpenPondProfileSetupRequiredError);
      if (!(thrown instanceof OpenPondProfileSetupRequiredError)) {
        throw new Error("expected structured setup-required error");
      }
      expect(thrown.details).toMatchObject({
        error: "agent_source_setup_required",
        actionId: "chat",
        missing: ["SUPPORT_API_KEY"],
        setupGate: {
          status: "setup_required",
          blockingCount: 1,
        },
        blockingSetupRequirements: [
          {
            actionId: "chat",
            kind: "env",
            label: "SUPPORT_API_KEY",
            required: true,
            status: "setup_required",
            blocking: true,
          },
        ],
      });
    } finally {
      await saveConfig(originalConfig);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("profile check validates every enabled profile agent source", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "openpond-profile-check-all-")
    );
    const originalConfig = await loadGlobalConfig();
    try {
      const repoPath = path.join(tempRoot, "profile-repo");
      const sourcePath = path.join(repoPath, "profiles", "default");
      await initLocalProfileRepo({ repoPath, profile: "default" });

      const invalidAgentId = "invalid-enabled-agent";
      const invalidAgentPath = path.join(sourcePath, "agents", invalidAgentId);
      await mkdir(invalidAgentPath, { recursive: true });
      await writeFile(
        path.join(invalidAgentPath, "agent.ts"),
        "export const invalidEnabledAgent = true;\n",
        "utf8"
      );

      const manifestPath = path.join(repoPath, "openpond-profile.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        profiles: Record<string, { enabledAgents?: string[] }>;
      };
      manifest.profiles.default.enabledAgents = ["default", invalidAgentId];
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8"
      );
      await writeFile(
        path.join(sourcePath, "settings", "profile.yaml"),
        [
          "schema: openpond.profile.v1",
          "profile: default",
          "agents:",
          "  - id: default",
          "    path: agent/agent.ts",
          "    enabled: true",
          `  - id: ${invalidAgentId}`,
          `    path: agents/${invalidAgentId}`,
          "    enabled: true",
          "",
        ].join("\n"),
        "utf8"
      );

      const state = await loadLocalProfileRepo(repoPath, "default");
      expect(state.catalog.stale).toBe(true);
      expect(state.catalog.error).toContain(`Profile agent ${invalidAgentId}`);
      expect(state.catalog.error).toContain(".openpond/agent-manifest.json");

      let thrown: unknown;
      try {
        await runProfileCheck("inspect");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      if (!(thrown instanceof Error)) {
        throw new Error(
          "expected profile check to fail for the invalid enabled source"
        );
      }
      expect(thrown.message).toContain(`enabled agent ${invalidAgentId}`);
      expect(thrown.message).toContain(
        "agent/agent.ts or openpond.yaml is required"
      );
    } finally {
      await saveConfig(originalConfig);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
