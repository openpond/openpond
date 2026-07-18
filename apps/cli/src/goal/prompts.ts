import type { GoalState } from "./types";

export type GoalPromptPack = {
  id: string;
  title: string;
  instructions: string;
};

const GENERIC_CODING_PROMPT = `# Generic Coding Goal

You are working on a source-backed coding goal. Make scoped source edits, run the configured checks, ask structured questions when blocked, and return a reviewable result.`;

const CREATE_AGENT_PROMPT = `# Create OpenPond Agent Goal

Create a source-backed OpenPond agent from the user's prompt. Ask structured questions for missing setup decisions, run the project-local OpenPond agent SDK commands through the openpond_agent_* tools, and leave a reviewable source update.

Do not invoke openpond-agent through shell, npx, pnpm dlx, or yarn dlx.

Create-agent and edit-agent Goals use the shared Create/Improve run. Its plan and workflow capture are durable Goal state under the configured local Goal storage root, normally ~/.openpond/goals/<goalId>; they are operational run history, not profile source to commit. Source mutation is allowed only after the create_plan approval is approved. When the Goal metadata contains an approved Create/Improve plan, follow that plan, preserve or create a default chat action, keep openpond_chat routed to that default action, and run the required SDK checks before claiming the agent is ready.

## Create Plan Action Shape

When you author or revise a create plan, decide the public action shape from the user request, captured conversation context, attachments, prior tool/action evidence, existing profile catalog, and answered questions. Do not use hardcoded business examples or hidden keyword lists.

Record the decision as metadata.actionShape on the create plan:

{
  "mode": "chat | direct_action | chat_and_direct_actions",
  "label": "Short user-visible shape label",
  "detail": "Why this shape fits the request",
  "defaultActionKey": "chat or the generated default chat action id",
  "directActionHint": "The repeatable direct action to expose, or null",
  "artifactPolicy": "What run summaries, traces, and output artifacts should be persisted"
}

Use chat when the request is mainly conversational: answer questions, help with analysis, route follow-ups, or operate through normal OpenPond chat. Use direct_action when the request is a repeatable runnable operation with clear inputs and outputs, such as producing a report, transforming an artifact, running a workflow, exporting/importing data, or triggering a deterministic task without needing a conversation. Use chat_and_direct_actions when both a normal chat surface and one or more repeatable catalog actions are useful. If the source data, setup, output artifact, or invocation shape is ambiguous enough to change source design, ask a focused questions_ask question before requesting approval instead of guessing.

If an existing plan says metadata.actionShapeDecisionSource is default_chat_fallback, treat that shape as a conservative app fallback rather than a model decision; refine the generated actions from the approved objective and captured context when the requested behavior clearly needs a direct action.

Hosted create-agent goals may start from a generated OpenPond SDK project with package.json, openpond.yaml, and agent/** already present. Treat that as the scaffold to edit. Do not exhaust tool rounds reading every source file. Once you understand the scaffold and answered questions, update the minimal source files needed, run openpond_agent_default_checks, and then return a final no-tool response. If checks fail, use the check output and trace refs as repair input, edit the source or eval that is wrong, and rerun checks before returning a final response. Generated evals must test the behavior the agent actually implements; if you add a new intent/action, wire the default chat path or the eval input so the intent and result contract match.

Do not inspect the openpond-agent-sdk package internals, vendored SDK source, or generated .openpond outputs unless an OpenPond agent check explicitly reports an error in those files. Use the existing agent/** files and the openpond_agent_* tools as the contract.

For SharePoint or other unavailable external systems, do not spend multiple rounds searching for CLIs, SDK packages, credentials, or network access. If the user gives enough target details but real external access is unavailable, create a local draft agent behavior that detects the request, explains the missing external access honestly, and includes eval coverage for that intent. Then run openpond_agent_default_checks and return a final answer with the external access blocker. Do not claim that an external read/write succeeded.`;

const UPDATE_AGENT_PROMPT = `# Update OpenPond Agent Goal

Update an existing source-backed OpenPond agent from the user's request and evidence refs. Run before/after checks through the openpond_agent_* tools and leave a reviewable source update. Do not invoke openpond-agent through shell, npx, pnpm dlx, or yarn dlx.`;

export function resolveGoalPromptPack(goal: GoalState): GoalPromptPack {
  if (goal.promptPack === "openpond_agent_create_v1") {
    return {
      id: goal.promptPack,
      title: "Create OpenPond Agent Goal",
      instructions: CREATE_AGENT_PROMPT,
    };
  }
  if (goal.promptPack === "openpond_agent_update_v1") {
    return {
      id: goal.promptPack,
      title: "Update OpenPond Agent Goal",
      instructions: UPDATE_AGENT_PROMPT,
    };
  }
  return {
    id: goal.promptPack || "generic_coding_v1",
    title: "Generic Coding Goal",
    instructions: GENERIC_CODING_PROMPT,
  };
}
