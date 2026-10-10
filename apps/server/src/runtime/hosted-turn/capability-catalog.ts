import { visualTools } from "../../visuals/visual-tools.js";
import { chatResourceToolDefinitions } from "../../openpond/chat-resource-tool-definitions.js";
import {candidateFileToolDefinitions} from "../../harness/experiment-candidate-tool-catalog.js";
import type {
  HarnessActionBinding,
  OpenPondActionCatalogEntry,
  RuntimeEvent,
  SubagentRoleSettings,
} from "@openpond/contracts";
import { createOpenPondCapabilityModelToolDefinitions } from "../../openpond/capability-tool-registry.js";
import { createBrowserModelToolDefinitions } from "../../openpond/browser-tool-registry.js";
import { createAuthoringModelToolDefinitions } from "../../openpond/authoring-tool-registry.js";
import { createLocalImageModelToolDefinition } from "../../openpond/local-image-tool-registry.js";
import { createConnectedAppProviderModelToolDefinitions } from "../../openpond/connected-app-tool-registry.js";
import type { ResolvedConnectedAppContext } from "../../openpond/connected-app-context.js";
import {
  createConnectedAppSkillModelToolDefinitions,
  createCommandModelToolDefinition,
  createOpenPondActionModelToolDefinitions,
  createOpenPondProfileSkillModelToolDefinitions,
  createResourceModelToolDefinitions,
  createWebFetchModelToolDefinition,
  createWebSearchModelToolDefinition,
  type ModelToolDefinition,
} from "../../openpond/model-tool-registry.js";
import type { TurnRunnerDependencies } from "../turns/ports.js";
import type { ProfileSkillRuntime } from "./native-tools-runtime.js";
import type { HostedToolRolloutFlags } from "./rollout.js";
import { createWorkModelToolDefinitions } from "../../openpond/work-tool-registry.js";

type CapabilityHandlers = Parameters<
  typeof createOpenPondCapabilityModelToolDefinitions
>[0];

export function createCapabilityCatalogRuntime(deps: {
  handlers: CapabilityHandlers;
  subagentToolsAvailable(): boolean;
  hostedToolFlags: HostedToolRolloutFlags;
  executeConnectedAppTool: TurnRunnerDependencies["executeConnectedAppTool"];
  browserToolExecutor: TurnRunnerDependencies["browserToolExecutor"];
  htmlVisuals?: TurnRunnerDependencies["htmlVisuals"];
  executeOpenPondCommand: TurnRunnerDependencies["executeOpenPondCommand"];
  executeWorkspaceTool: TurnRunnerDependencies["executeWorkspaceTool"];
  executeWebSearch: TurnRunnerDependencies["executeWebSearch"];
  createScheduledWork: TurnRunnerDependencies["createScheduledWork"];
  executeProfileAction: TurnRunnerDependencies["executeProfileAction"];
  executeProjectAction: TurnRunnerDependencies["executeProjectAction"];
  executeChatResourceAction?: TurnRunnerDependencies["executeChatResourceAction"];
  loadOpenPondProfileStateForRef: TurnRunnerDependencies["loadOpenPondProfileStateForRef"];
  resolveCandidateProfile?: TurnRunnerDependencies["resolveCandidateProfile"];
  executeCandidateAgentCommand?: TurnRunnerDependencies["executeCandidateAgentCommand"];
  executeCandidateCommand?: TurnRunnerDependencies["executeCandidateCommand"];
  executeCandidateImage?: TurnRunnerDependencies["executeCandidateImage"];
}) {
  return function createNativeModelToolDefinitions(
    openPondActionCatalog: OpenPondActionCatalogEntry[],
    runtimeEvents: RuntimeEvent[],
    profileSkillRuntime: ProfileSkillRuntime,
    connectedApps: ResolvedConnectedAppContext[],
    options: {
      candidateAuthoring?: boolean;
      visualToolsEnabled?: boolean;
      disableWorkflowDelegationTools?: boolean;
      subagentRoles?: readonly SubagentRoleSettings[];
      subagentToolsEnabled?: boolean;
      trainingHarness?: {
        taskId: string;
        actionBindings: HarnessActionBinding[];
      };
      workInputs?: ReadonlyArray<{
        localPath?: string;
        storageName?: string;
      }>;
    } = {}
  ): ModelToolDefinition[] {
    const definitions: ModelToolDefinition[] = [];
    if(options.candidateAuthoring){
      const authoring=createAuthoringModelToolDefinitions({loadProfileState:deps.loadOpenPondProfileStateForRef,resolveCandidateProfile:deps.resolveCandidateProfile,executeCandidateAgentCommand:deps.executeCandidateAgentCommand});
      return [...authoring,...candidateFileToolDefinitions(deps.executeWorkspaceTool),
        createCommandModelToolDefinition({executeCommand:deps.executeOpenPondCommand??(async()=>{throw new Error("Candidate command executor is unavailable.");}),executeCandidateCommand:deps.executeCandidateCommand}),
        createLocalImageModelToolDefinition({executeCandidateImage:deps.executeCandidateImage})];
    }
    if (options.trainingHarness) {
      return createOpenPondActionModelToolDefinitions({
        actionCatalog: openPondActionCatalog,
        executeWorkspaceTool: deps.executeWorkspaceTool,
        executeProfileAction: deps.executeProfileAction,
        executeProjectAction: deps.executeProjectAction,
        trainingHarness: options.trainingHarness,
      });
    }
    definitions.push(...chatResourceToolDefinitions(deps.executeChatResourceAction));
    if (!options.disableWorkflowDelegationTools) {
      const handlers: CapabilityHandlers = {
        ...(deps.handlers.manageSidebarFile
          ? { manageSidebarFile: deps.handlers.manageSidebarFile }
          : {}),
        ...(deps.handlers.runDatasetBuilder
          ? { runDatasetBuilder: deps.handlers.runDatasetBuilder }
          : {}),
        ...(deps.subagentToolsAvailable() &&
        options.subagentToolsEnabled !== false
          ? {
              startSubagent: deps.handlers.startSubagent,
              statusSubagents: deps.handlers.statusSubagents,
              joinSubagent: deps.handlers.joinSubagent,
              cancelSubagent: deps.handlers.cancelSubagent,
              followupSubagent: deps.handlers.followupSubagent,
              sendSubagentMessage: deps.handlers.sendSubagentMessage,
              subagentRoles: options.subagentRoles,
            }
          : {}),
      };
      definitions.push(
        ...createOpenPondCapabilityModelToolDefinitions(handlers)
      );
    }
    definitions.push(
      ...createAuthoringModelToolDefinitions({
        loadProfileState: deps.loadOpenPondProfileStateForRef,
        resolveCandidateProfile: deps.resolveCandidateProfile,
        executeCandidateAgentCommand: deps.executeCandidateAgentCommand,
      })
    );
    definitions.push(
      ...createConnectedAppSkillModelToolDefinitions({
        connectedApps: connectedApps.map((app) => ({
          provider: app.provider,
          label: app.label,
        })),
      })
    );
    definitions.push(
      ...createConnectedAppProviderModelToolDefinitions({
        connectedApps,
        executeConnectedAppTool: deps.executeConnectedAppTool,
      })
    );
    definitions.push(
      ...createWorkModelToolDefinitions({
        executeWorkspaceTool: deps.executeWorkspaceTool,
        inputs: options.workInputs,
        automaticLifecycle: true,
        createScheduledWork: deps.createScheduledWork,
      })
    );
    definitions.push(
      ...(options.visualToolsEnabled ? visualTools(deps.htmlVisuals) : []),
      ...createBrowserModelToolDefinitions(deps.browserToolExecutor)
    );
    if (deps.executeOpenPondCommand) {
      definitions.push(
        createCommandModelToolDefinition({
          executeCommand: deps.executeOpenPondCommand,
          executeCandidateCommand: deps.executeCandidateCommand,
        })
      );
      definitions.push(createLocalImageModelToolDefinition({ executeCandidateImage: deps.executeCandidateImage }));
    }
    if (deps.hostedToolFlags.resourceTools) {
      definitions.push(
        ...createResourceModelToolDefinitions({
          executeWorkspaceTool: deps.executeWorkspaceTool,
          runtimeEvents,
        })
      );
    }
    if (deps.hostedToolFlags.webSearchTool)
      definitions.push(createWebFetchModelToolDefinition());
    if (deps.hostedToolFlags.webSearchTool && deps.executeWebSearch) {
      definitions.push(
        createWebSearchModelToolDefinition({
          executeWebSearch: deps.executeWebSearch,
        })
      );
    }
    if (
      profileSkillRuntime.readSkill &&
      profileSkillRuntime.skills.length > 0
    ) {
      definitions.push(
        ...createOpenPondProfileSkillModelToolDefinitions({
          skills: profileSkillRuntime.skills,
          readProfileSkill: profileSkillRuntime.readSkill,
        })
      );
    }
    if (deps.hostedToolFlags.dynamicActionTools) {
      definitions.push(
        ...createOpenPondActionModelToolDefinitions({
          actionCatalog: openPondActionCatalog,
          executeWorkspaceTool: deps.executeWorkspaceTool,
          executeProfileAction: deps.executeProfileAction,
          executeProjectAction: deps.executeProjectAction,
        })
      );
    }
    return definitions;
  };
}
