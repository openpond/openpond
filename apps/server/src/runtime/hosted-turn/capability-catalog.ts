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
  executeOpenPondCommand: TurnRunnerDependencies["executeOpenPondCommand"];
  executeWorkspaceTool: TurnRunnerDependencies["executeWorkspaceTool"];
  executeWebSearch: TurnRunnerDependencies["executeWebSearch"];
  executeProfileAction: TurnRunnerDependencies["executeProfileAction"];
  executeCrossSystemTool: TurnRunnerDependencies["executeCrossSystemTool"];
  loadOpenPondProfileStateForRef: TurnRunnerDependencies["loadOpenPondProfileStateForRef"];
}) {
  return function createNativeModelToolDefinitions(
    openPondActionCatalog: OpenPondActionCatalogEntry[],
    runtimeEvents: RuntimeEvent[],
    profileSkillRuntime: ProfileSkillRuntime,
    connectedApps: ResolvedConnectedAppContext[],
    options: {
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
    if (options.trainingHarness) {
      return createOpenPondActionModelToolDefinitions({
        actionCatalog: openPondActionCatalog,
        executeWorkspaceTool: deps.executeWorkspaceTool,
        executeProfileAction: deps.executeProfileAction,
        executeCrossSystemTool: deps.executeCrossSystemTool,
        trainingHarness: options.trainingHarness,
      });
    }
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
      })
    );
    definitions.push(
      ...createBrowserModelToolDefinitions(deps.browserToolExecutor)
    );
    if (deps.executeOpenPondCommand) {
      definitions.push(
        createCommandModelToolDefinition({
          executeCommand: deps.executeOpenPondCommand,
        })
      );
      definitions.push(createLocalImageModelToolDefinition());
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
          executeCrossSystemTool: deps.executeCrossSystemTool,
        })
      );
    }
    return definitions;
  };
}
