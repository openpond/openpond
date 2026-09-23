import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { executeReleasedProfileWorkflowAction } from "./released-profile-workflow-action.js";

describe("released Profile workflow action", () => {
  it("runs a TypeScript Agent package with the host SDK and keeps the release untouched", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-workflow-action-"));
    const bundle = path.join(root, "library", "harnesses", "releases", "release");
    try {
      const agentPath = path.join(bundle, "source", "agents", "default", "agent");
      await fs.mkdir(agentPath, { recursive: true });
      const source = `import { action, defineAgentProject, defineWorkflow } from "openpond-agent-sdk/primitives";
const publish = defineWorkflow({ name: "publish-workflow", async run(_ctx, input) { return { text: String(input.title), intent: "publish" }; } });
export default defineAgentProject({ name: "fixture", version: "0.1.0", useCase: "test", manifestMode: "typescript", runtime: { base: "node-bun-workspace" }, defaultAction: "publish", actions: [action("publish", { target: { kind: "workflow", workflow: publish } })], workflows: [publish] });\n`;
      await fs.writeFile(path.join(agentPath, "agent.ts"), source);
      const result = await executeReleasedProfileWorkflowAction({
        action: { id: "publish", agentId: "default", sourceActionId: "publish", inputSchema: { type: "object" } },
        releaseBundlePath: bundle,
        value: { title: "Quarterly report" },
        runId: "run-typescript",
      });
      expect(JSON.parse(result.output)).toMatchObject({ result: { intent: "publish", text: "Quarterly report" } });
      expect(await fs.readFile(path.join(agentPath, "agent.ts"), "utf8")).toBe(source);
      expect(result.runPath).not.toContain(path.join("releases", "release", "source"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs a portable YAML Agent action from released source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-workflow-action-"));
    const bundle = path.join(root, "library", "harnesses", "releases", "release");
    try {
      const agentPath = path.join(bundle, "source", "agents", "default");
      await fs.mkdir(agentPath, { recursive: true });
      await fs.writeFile(path.join(agentPath, "openpond.yaml"), "name: fixture\nactions:\n  - name: publish\n");
      const result = await executeReleasedProfileWorkflowAction({
        action: { id: "publish", agentId: "default", sourceActionId: "publish", inputSchema: { type: "object" } },
        releaseBundlePath: bundle,
        value: { title: "Quarterly report" },
        runId: "run-yaml",
      });
      expect(JSON.parse(result.output)).toMatchObject({ result: { intent: "publish", metadata: { input: { title: "Quarterly report" } } } });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes validated input to the Agent SDK from the immutable release directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-workflow-action-"));
    const bundle = path.join(root, "library", "harnesses", "releases", "release");
    const agentPath = path.join(bundle, "source", "agents", "default");
    await fs.mkdir(agentPath, { recursive: true });
    await fs.writeFile(path.join(agentPath, "openpond.yaml"), "name: fixture\nactions:\n  - name: publish\n");
    const run = vi.fn(async () => ({
      code: 0, stdout: "published", stderr: "", timedOut: false,
      stdoutTruncated: false, stderrTruncated: false,
    }));
    try {
    const result = await executeReleasedProfileWorkflowAction({
      action: {
        id: "publish", agentId: "default", sourceActionId: "publish-document",
        inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      },
      releaseBundlePath: bundle,
      value: { title: "Quarterly report" },
      runId: "run-1",
      run,
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      command: "run", cwd: result.runPath,
      args: ["publish-document", "--cwd", result.runPath, "--input", JSON.stringify({ title: "Quarterly report" }), "--out-dir", path.join(result.runPath, ".openpond")],
    }));
    expect(result).toMatchObject({ output: "published", agentSourcePath: agentPath });
    expect(await fs.readFile(path.join(result.runPath, "openpond.yaml"), "utf8")).toContain("name: fixture");
    await expect(executeReleasedProfileWorkflowAction({
      action: {
        id: "publish", agentId: "default", sourceActionId: "publish-document",
        inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      },
      releaseBundlePath: bundle,
      value: { title: 7 },
      runId: "run-2",
      run,
    })).rejects.toThrow(/input is invalid/);
    expect(run).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
