import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { executeReleasedProfileWorkflowAction } from "./released-profile-workflow-action.js";

describe("released Profile workflow action", () => {
  it("runs a portable YAML Agent action from released source", async () => {
    const bundle = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-workflow-action-"));
    try {
      const agentPath = path.join(bundle, "source", "agents", "default");
      await fs.mkdir(agentPath, { recursive: true });
      await fs.writeFile(path.join(agentPath, "openpond.yaml"), "name: fixture\nactions:\n  - name: publish\n");
      const result = await executeReleasedProfileWorkflowAction({
        action: { id: "publish", agentId: "default", sourceActionId: "publish", inputSchema: { type: "object" } },
        releaseBundlePath: bundle,
        value: { title: "Quarterly report" },
      });
      expect(JSON.parse(result.output)).toMatchObject({ result: { intent: "publish", metadata: { input: { title: "Quarterly report" } } } });
    } finally {
      await fs.rm(bundle, { recursive: true, force: true });
    }
  });

  it("passes validated input to the Agent SDK from the immutable release directory", async () => {
    const run = vi.fn(async () => ({
      code: 0, stdout: "published", stderr: "", timedOut: false,
      stdoutTruncated: false, stderrTruncated: false,
    }));
    const result = await executeReleasedProfileWorkflowAction({
      action: {
        id: "publish", agentId: "default", sourceActionId: "publish-document",
        inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      },
      releaseBundlePath: "/releases/abc",
      value: { title: "Quarterly report" },
      run,
    });
    const source = path.join("/releases/abc", "source", "agents", "default");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      command: "run", cwd: source,
      args: ["publish-document", "--cwd", source, "--input", JSON.stringify({ title: "Quarterly report" })],
    }));
    expect(result).toEqual({ output: "published", agentSourcePath: source });
    await expect(executeReleasedProfileWorkflowAction({
      action: {
        id: "publish", agentId: "default", sourceActionId: "publish-document",
        inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      },
      releaseBundlePath: "/releases/abc",
      value: { title: 7 },
      run,
    })).rejects.toThrow(/input is invalid/);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
