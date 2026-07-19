import { loadOpenPondProfileState } from "@openpond/cloud";
import { createLocalGoal, runGoalCommand } from "../goal/cli";

type CliOptions = Record<string, string | boolean>;

export async function runOpenPondExtendCommand(options: CliOptions, rest: string[]): Promise<void> {
  await runOpenPondAgentPipelineCommand({
    options,
    rest,
    kind: "create_agent",
    command: "openpond extend",
    surface: "local_extend",
    usage: 'usage: extend "<profile capability change>" [--run]',
  });
}

export async function runOpenPondEditCommand(options: CliOptions, rest: string[]): Promise<void> {
  await runOpenPondAgentPipelineCommand({
    options,
    rest,
    kind: "update_agent",
    command: "/edit",
    surface: "direct_prompt_improve",
    usage: 'usage: edit "<profile agent change>" [--agent-id <id>] [--run]',
  });
}

async function runOpenPondAgentPipelineCommand(params: {
  options: CliOptions;
  rest: string[];
  kind: "create_agent" | "update_agent";
  command: "openpond extend" | "/edit";
  surface: "local_extend" | "direct_prompt_improve";
  usage: string;
}): Promise<void> {
  const { options, rest } = params;
  const state = await loadOpenPondProfileState();
  if (state.error) throw new Error(state.error);
  if (!state.sourcePath) {
    throw new Error("No active OpenPond profile. Run `openpond init` or `openpond profile load --path <dir>`.");
  }
  const goalOptions = { ...options };
  if (typeof goalOptions.cwd !== "string" || goalOptions.cwd.trim().length === 0) {
    goalOptions.cwd = state.sourcePath;
  }
  if (params.kind === "update_agent") {
    const selectedAgentId =
      typeof goalOptions.agentId === "string" && goalOptions.agentId.trim()
        ? goalOptions.agentId.trim()
        : state.agents[0]?.id ?? "default";
    goalOptions.agentId = selectedAgentId;
  }
  const objective = rest.join(" ").trim();
  if (!objective) {
    throw new Error(params.usage);
  }
  const goal = await createLocalGoal({
    options: goalOptions,
    objective,
    kind: params.kind,
    createImprove: {
      command: params.command,
      surface: params.surface,
      profile: {
        activeProfile: state.activeProfile,
        repoPath: state.repoPath,
        sourcePath: state.sourcePath,
        localHead: state.git?.head ?? null,
      },
    },
  });
  if (options.run === true || options.run === "true") {
    await runGoalCommand({ ...goalOptions, goalId: goal.id }, ["run"]);
  }
}
