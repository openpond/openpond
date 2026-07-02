import { promises as fs } from "node:fs";
import path from "node:path";
import {
  formatSandboxTemplateDiagnostics,
  OPENPOND_MANIFEST_FILE_NAME,
  sandboxTemplateBuildPlan,
  SANDBOX_TEMPLATE_BUILD_PLAN_FILE_NAME,
  validateSandboxTemplateYaml,
  type RuntimeEvent,
  type Session,
} from "@openpond/contracts";
import { event, textFromUnknown } from "../utils.js";
import type { CheckResult } from "../workspace-tools/workspace-tool-common.js";

export type WorkspaceActionSource = "ui_button" | "chat_action" | "terminal_command" | "hook";

export function createWorkspaceManagedWorkflows(deps: {
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
}) {
  const { appendRuntimeEvent } = deps;

  async function runSandboxTemplateCheckActionEvent(
    session: Session,
    turnId: string | undefined,
    source: WorkspaceActionSource,
    action: "validate_sandbox_template" | "build_sandbox_template",
    repoPath: string
  ): Promise<CheckResult> {
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId,
        name: "workspace_action",
        source,
        action,
        appId: session.appId,
        args: { repoPath },
        status: "started",
      })
    );
    const result = await runSandboxTemplateCheck(repoPath, action);
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId,
        name: "workspace_action_result",
        source,
        action,
        appId: session.appId,
        status: result.ok ? "completed" : "failed",
        output: result.ok ? `${action} passed` : `${action} failed`,
        error: result.ok ? undefined : result.stderr || result.stdout || `${action} failed`,
        data: result,
      })
    );
    return result;
  }

  async function runPostEditChecks(
    session: Session,
    turnId: string | undefined,
    source: WorkspaceActionSource,
    repoPath: string
  ): Promise<CheckResult[]> {
    if (session.workspaceKind === "local_project") {
      if (await hasSandboxTemplateManifest(repoPath)) {
        const validate = await runSandboxTemplateCheckActionEvent(
          session,
          turnId,
          source,
          "validate_sandbox_template",
          repoPath
        );
        const checks = [validate];
        if (validate.ok) {
          checks.push(await runSandboxTemplateCheckActionEvent(session, turnId, source, "build_sandbox_template", repoPath));
        }
        return checks;
      }
    }
    return [];
  }

  async function runPostEditWorkflow(input: {
    session: Session;
    app: { id: string };
    state: { repoPath: string };
    turnId?: string;
    source: WorkspaceActionSource;
    args: Record<string, unknown>;
    runChecks: boolean;
  }): Promise<{
    ok: boolean;
    checks: CheckResult[];
    managed: Record<string, unknown> | null;
  }> {
    const checks = input.runChecks
      ? await runPostEditChecks(input.session, input.turnId, input.source, input.state.repoPath)
      : [];
    const checksOk = checks.length === 0 || checks.every((check) => check.ok);
    return { ok: checksOk, checks, managed: null };
  }

  return {
    runPostEditChecks,
    runPostEditWorkflow,
  };
}

async function hasSandboxTemplateManifest(repoPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoPath, OPENPOND_MANIFEST_FILE_NAME));
    return true;
  } catch {
    return false;
  }
}

async function runSandboxTemplateCheck(
  repoPath: string,
  action: "validate_sandbox_template" | "build_sandbox_template"
): Promise<CheckResult> {
  const manifestPath = path.join(repoPath, OPENPOND_MANIFEST_FILE_NAME);
  try {
    const source = await fs.readFile(manifestPath, "utf8");
    const result = validateSandboxTemplateYaml(source);
    if (!result.ok) {
      return {
        ok: false,
        command: action,
        code: 1,
        stdout: "",
        stderr: formatSandboxTemplateDiagnostics(result.diagnostics),
      };
    }

    if (action === "validate_sandbox_template") {
      return {
        ok: true,
        command: action,
        code: 0,
        stdout: `Sandbox template ${result.manifest.name} is valid.`,
        stderr: "",
      };
    }

    const outputPath = path.join(repoPath, "dist", SANDBOX_TEMPLATE_BUILD_PLAN_FILE_NAME);
    const plan = sandboxTemplateBuildPlan({
      manifest: result.manifest,
      manifestFile: OPENPOND_MANIFEST_FILE_NAME,
      projectRoot: path.relative(path.dirname(outputPath), repoPath) || ".",
    });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    return {
      ok: true,
      command: action,
      code: 0,
      stdout: `Built sandbox template ${result.manifest.name} to ${path.relative(repoPath, outputPath)}.`,
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      command: action,
      code: 1,
      stdout: "",
      stderr: textFromUnknown(error),
    };
  }
}
