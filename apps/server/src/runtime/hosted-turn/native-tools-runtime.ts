import {
  type ChatProvider,
  type ConnectedAppIntegrationSkill,
  type OpenPondApp,
  type OpenPondProfileSkill,
  type RuntimeEvent,
  SessionUserQuestionSchema,
  type Session,
  type Turn,
  type WorkspaceDiffSummary,
} from "@openpond/contracts";
import {
  executeProjectedAgentTool,
  type AgentToolCatalogProjection,
} from "@openpond/agent-runtime";
import {
  isConnectedAppProviderToolName,
  redactConnectedAppToolArguments,
} from "../../openpond/connected-app-tool-registry.js";
import { redactBrowserToolArguments } from "../../openpond/browser-tool-registry.js";
import type { ProfileSkillReadResult } from "../../openpond/model-tool-registry.js";
import type { HostedProfileSkillBody } from "../../openpond/hosted-turn-helpers.js";
import {
  invalidNativeToolArgumentsResult,
  parseNativeToolArguments,
  unknownNativeToolResult,
  type NativeModelToolCall,
  type NativeModelToolResult,
} from "../../openpond/native-tool-calls.js";
import { event, textFromUnknown } from "../../utils.js";
import type { SubagentTurnPermissions } from "../subagents/continuation-runtime.js";
import { stringFromRecord } from "../turns/value-utils.js";

export type ProfileSkillRuntime = {
  profileSourcePath: string | null;
  skills: OpenPondProfileSkill[];
  readSkill: ((name: string) => Promise<ProfileSkillReadResult>) | null;
};

export function createNativeToolRuntime(deps: {
  maxRepeatedInvalidToolRequests: number;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  throwIfInterrupted(signal: AbortSignal): void;
}) {
  const maxImageInspectionsPerTurn = 12;
  const maxRepeatedInvalidToolRequests = deps.maxRepeatedInvalidToolRequests;
  const appendRuntimeEvent = deps.appendRuntimeEvent;
  const throwIfInterrupted = deps.throwIfInterrupted;
  async function executeNativeToolCalls(params: {
    session: Session;
    turnId: string;
    turnPermissions: SubagentTurnPermissions;
    provider: ChatProvider;
    model: string;
    signal: AbortSignal;
    workspaceDiffBaseline: WorkspaceDiffSummary | null;
    mentionedApps: OpenPondApp[];
    userPrompt: string;
    turnMetadata: Turn["metadata"];
    toolCatalog: AgentToolCatalogProjection;
    invalidRequestCounts: Map<string, number>;
    toolCalls: NativeModelToolCall[];
  }): Promise<NativeModelToolResult[]> {
    const results: NativeModelToolResult[] = [];
    const blockingQuestionCall = params.toolCalls.find((toolCall) => toolCall.name === "ask_user") ?? null;
    for (const toolCall of params.toolCalls) {
      throwIfInterrupted(params.signal);
      if (blockingQuestionCall && toolCall.id !== blockingQuestionCall.id) {
        const result: NativeModelToolResult = {
          toolCallId: toolCall.id,
          name: toolCall.name,
          ok: false,
          contentText: JSON.stringify({
            ok: false,
            action: toolCall.name,
            output: "Skipped because ask_user must be the only executed call in its tool batch.",
            data: { skipped: true, reason: "ask_user_requires_exclusive_batch" },
          }, null, 2),
          data: { skipped: true, reason: "ask_user_requires_exclusive_batch" },
        };
        await appendNativeToolStarted(params.session, params.turnId, toolCall, {});
        await appendNativeToolCompleted(params.session, params.turnId, result);
        results.push(result);
        continue;
      }
      const definition = params.toolCatalog.byName.get(toolCall.name);
      if (!definition) {
        const result = unknownNativeToolResult(toolCall);
        await appendNativeToolStarted(params.session, params.turnId, toolCall, {});
        await appendNativeToolCompleted(params.session, params.turnId, result);
        results.push(result);
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = parseNativeToolArguments(toolCall);
      } catch (error) {
        const message = textFromUnknown(error) || "Invalid JSON.";
        const key = `${toolCall.name}:native_json:${toolCall.argumentsJson}`;
        const count = (params.invalidRequestCounts.get(key) ?? 0) + 1;
        params.invalidRequestCounts.set(key, count);
        if (count >= maxRepeatedInvalidToolRequests) {
          throw new Error(`Hosted native tool produced repeated invalid ${toolCall.name} arguments: ${message}`);
        }
        const result = invalidNativeToolArgumentsResult(toolCall, message);
        await appendNativeToolStarted(
          params.session,
          params.turnId,
          toolCall,
          nativeToolInvalidArgumentsEventArgs(toolCall.name, toolCall.argumentsJson),
        );
        await appendNativeToolCompleted(params.session, params.turnId, result);
        results.push(result);
        continue;
      }

      if (toolCall.name === "view_image") {
        const budgetKey = "budget:view_image";
        const count = (params.invalidRequestCounts.get(budgetKey) ?? 0) + 1;
        params.invalidRequestCounts.set(budgetKey, count);
        if (count > maxImageInspectionsPerTurn) {
          const result: NativeModelToolResult = {
            toolCallId: toolCall.id,
            name: toolCall.name,
            ok: false,
            contentText: JSON.stringify({
              ok: false,
              action: toolCall.name,
              output: `This turn already inspected ${maxImageInspectionsPerTurn} images. Stop frame-by-frame inspection; create one contact sheet for any remaining frames, inspect it once, then finish the task.`,
            }, null, 2),
            data: { limit: maxImageInspectionsPerTurn, reason: "image_inspection_budget" },
          };
          await appendNativeToolStarted(params.session, params.turnId, toolCall, nativeToolEventArgs(toolCall.name, args));
          await appendNativeToolCompleted(params.session, params.turnId, result);
          results.push(result);
          continue;
        }
      }

      const profileSkillName = toolCall.name === "profile_skill_read" ? stringFromRecord(args, "name") : null;
      const connectedAppSkillProvider = toolCall.name === "connected_app_skill_read" ? stringFromRecord(args, "provider") : null;
      if (profileSkillName) {
        await appendProfileSkillEvent({
          session: params.session,
          turnId: params.turnId,
          eventName: "skill.selected",
          status: "completed",
          output: `Selected profile skill ${profileSkillName}.`,
          skillName: profileSkillName,
          source: "provider",
        });
      }
      if (connectedAppSkillProvider) {
        await appendConnectedAppSkillEvent({
          session: params.session,
          turnId: params.turnId,
          eventName: "skill.selected",
          status: "completed",
          output: `Selected connected app instructions for ${connectedAppSkillProvider}.`,
          provider: connectedAppSkillProvider,
          source: "provider",
        });
      }

      await appendNativeToolStarted(
        params.session,
        params.turnId,
        toolCall,
        nativeToolEventArgs(toolCall.name, args),
      );
      try {
        const result = (await executeProjectedAgentTool(params.toolCatalog, {
          name: toolCall.name,
          arguments: args,
          context: {
            threadId: params.session.id,
            turnId: params.turnId,
            callId: toolCall.id,
            signal: params.signal,
          },
        })) as NativeModelToolResult;
        await appendNativeToolCompleted(params.session, params.turnId, result);
        if (profileSkillName) {
          const skill = profileSkillFromNativeResult(result);
          await appendProfileSkillEvent({
            session: params.session,
            turnId: params.turnId,
            eventName: result.ok ? "skill.loaded" : "skill.load_failed",
            status: result.ok ? "completed" : "failed",
            output: result.ok
              ? `Loaded profile skill ${profileSkillName}.`
              : result.contentText,
            skillName: profileSkillName,
            skill,
            source: "provider",
          });
        }
        if (connectedAppSkillProvider) {
          const skill = connectedAppSkillFromNativeResult(result);
          await appendConnectedAppSkillEvent({
            session: params.session,
            turnId: params.turnId,
            eventName: result.ok ? "skill.loaded" : "skill.load_failed",
            status: result.ok ? "completed" : "failed",
            output: result.ok
              ? `Loaded connected app instructions for ${connectedAppSkillProvider}.`
              : result.contentText,
            provider: connectedAppSkillProvider,
            skill,
            source: "provider",
          });
        }
        results.push(result);
      } catch (error) {
        const result = failedNativeToolResult(toolCall, textFromUnknown(error) || "Tool execution failed.");
        await appendNativeToolCompleted(params.session, params.turnId, result);
        if (profileSkillName) {
          await appendProfileSkillEvent({
            session: params.session,
            turnId: params.turnId,
            eventName: "skill.load_failed",
            status: "failed",
            output: result.contentText,
            skillName: profileSkillName,
            source: "provider",
          });
        }
        if (connectedAppSkillProvider) {
          await appendConnectedAppSkillEvent({
            session: params.session,
            turnId: params.turnId,
            eventName: "skill.load_failed",
            status: "failed",
            output: result.contentText,
            provider: connectedAppSkillProvider,
            source: "provider",
          });
        }
        results.push(result);
      }
    }
    return results;
  }

  async function readProfileSkillForModel(input: {
    session: Session;
    turnId: string;
    runtime: ProfileSkillRuntime;
    name: string;
    source: "provider" | "server";
  }): Promise<string> {
    const name = input.name.trim();
    await appendProfileSkillEvent({
      session: input.session,
      turnId: input.turnId,
      eventName: "skill.selected",
      status: "completed",
      output: `Selected profile skill ${name}.`,
      skillName: name,
      source: input.source,
    });
    if (!input.runtime.readSkill) {
      const message = "Profile skill reading is not configured for this turn.";
      await appendProfileSkillEvent({
        session: input.session,
        turnId: input.turnId,
        eventName: "skill.load_failed",
        status: "failed",
        output: message,
        skillName: name,
        source: input.source,
      });
      return profileSkillModelResult({ ok: false, name, output: message });
    }
    if (!input.runtime.skills.some((skill) => skill.name === name)) {
      const message = `Profile skill ${name} is not in the active enabled skill catalog.`;
      await appendProfileSkillEvent({
        session: input.session,
        turnId: input.turnId,
        eventName: "skill.load_failed",
        status: "failed",
        output: message,
        skillName: name,
        source: input.source,
      });
      return profileSkillModelResult({ ok: false, name, output: message });
    }
    try {
      const skill = await input.runtime.readSkill(name);
      await appendProfileSkillEvent({
        session: input.session,
        turnId: input.turnId,
        eventName: "skill.loaded",
        status: "completed",
        output: `Loaded profile skill ${name}.`,
        skillName: name,
        skill,
        source: input.source,
      });
      return profileSkillModelResult({
        ok: true,
        name,
        output: `Loaded profile skill ${name}.`,
        skill,
      });
    } catch (error) {
      const message = textFromUnknown(error) || `Failed to load profile skill ${name}.`;
      await appendProfileSkillEvent({
        session: input.session,
        turnId: input.turnId,
        eventName: "skill.load_failed",
        status: "failed",
        output: message,
        skillName: name,
        source: input.source,
      });
      return profileSkillModelResult({ ok: false, name, output: message });
    }
  }

  function profileSkillModelResult(input: {
    ok: boolean;
    name: string;
    output: string;
    skill?: ProfileSkillReadResult;
  }): string {
    return JSON.stringify(
      {
        ok: input.ok,
        action: "profile_skill_read",
        output: input.output,
        data: input.skill ? { skill: input.skill } : { name: input.name },
      },
      null,
      2,
    );
  }

  async function appendProfileSkillEvent(input: {
    session: Session;
    turnId: string;
    eventName: "skill.selected" | "skill.loaded" | "skill.load_failed";
    status: "completed" | "failed";
    output: string;
    skillName: string;
    skill?: ProfileSkillReadResult | HostedProfileSkillBody | null;
    source: "provider" | "server";
  }): Promise<void> {
    await appendRuntimeEvent(
      event({
        sessionId: input.session.id,
        turnId: input.turnId,
        name: input.eventName,
        source: input.source,
        action: "profile_skill_read",
        appId: input.session.appId,
        status: input.status,
        output: input.output,
        error: input.status === "failed" ? input.output : undefined,
        data: {
          skillName: input.skillName,
          type: "profile_skill",
          ...(input.skill
            ? {
                path: input.skill.path,
                sourceHash: input.skill.sourceHash,
              }
            : {}),
        },
      }),
    );
  }

  async function appendConnectedAppSkillEvent(input: {
    session: Session;
    turnId: string;
    eventName: "skill.selected" | "skill.loaded" | "skill.load_failed";
    status: "completed" | "failed";
    output: string;
    provider: string;
    skill?: ConnectedAppIntegrationSkill | null;
    source: "provider" | "server";
  }): Promise<void> {
    await appendRuntimeEvent(
      event({
        sessionId: input.session.id,
        turnId: input.turnId,
        name: input.eventName,
        source: input.source,
        action: "connected_app_skill_read",
        appId: input.session.appId,
        status: input.status,
        output: input.output,
        error: input.status === "failed" ? input.output : undefined,
        data: {
          provider: input.provider,
          skillName: input.skill?.name ?? `${input.provider}-connected-app`,
          type: "connected_app_skill",
          ...(input.skill
            ? {
                path: input.skill.path,
                sourceHash: input.skill.sourceHash,
              }
            : {}),
        },
      }),
    );
  }

  function explicitProfileSkillNames(prompt: string): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const match of prompt.matchAll(/\$([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b/g)) {
      const name = match[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    return names;
  }

  function profileSkillBodyFromReadResult(skill: ProfileSkillReadResult): HostedProfileSkillBody {
    return {
      name: skill.name,
      description: skill.description,
      body: skill.body,
      path: skill.path,
      sourceHash: skill.sourceHash,
      packagePath: skill.packagePath,
      resourceFiles: skill.resourceFiles,
    };
  }

  function profileSkillFromNativeResult(result: NativeModelToolResult): ProfileSkillReadResult | null {
    const data = result.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const skill = (data as Record<string, unknown>).skill;
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) return null;
    const record = skill as Record<string, unknown>;
    const name = stringFromRecord(record, "name");
    const description = stringFromRecord(record, "description");
    const body = stringFromRecord(record, "body");
    const path = stringFromRecord(record, "path");
    const sourceHash = stringFromRecord(record, "sourceHash");
    const charCount = typeof record.charCount === "number" ? record.charCount : null;
    if (!name || !description || !body || !path || !sourceHash || charCount === null) return null;
    const packagePath = stringFromRecord(record, "packagePath");
    const resourceFiles = Array.isArray(record.resourceFiles)
      ? record.resourceFiles.filter((file): file is string => typeof file === "string")
      : [];
    return {
      name,
      description,
      body,
      path,
      sourceHash,
      charCount,
      ...(packagePath ? { packagePath } : {}),
      resourceFiles,
    };
  }

  function connectedAppSkillFromNativeResult(result: NativeModelToolResult): ConnectedAppIntegrationSkill | null {
    const data = result.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const skill = (data as Record<string, unknown>).skill;
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) return null;
    const record = skill as Record<string, unknown>;
    const name = stringFromRecord(record, "name");
    const description = stringFromRecord(record, "description");
    const body = stringFromRecord(record, "body");
    const path = stringFromRecord(record, "path");
    const sourceHash = stringFromRecord(record, "sourceHash");
    const provider = stringFromRecord(record, "provider");
    const charCount = typeof record.charCount === "number" ? record.charCount : null;
    if (!name || !description || !body || !path || !sourceHash || !provider || charCount === null) return null;
    return {
      name,
      description,
      body,
      path,
      sourceHash,
      provider: provider as ConnectedAppIntegrationSkill["provider"],
      charCount,
    };
  }

  function nativeToolEventArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    const browserArgs = redactBrowserToolArguments(toolName, args);
    if (browserArgs !== args) return browserArgs;
    return redactConnectedAppToolArguments(toolName, args);
  }

  function nativeToolInvalidArgumentsEventArgs(toolName: string, argumentsJson: string): Record<string, unknown> {
    if (!isConnectedAppProviderToolName(toolName)) return { argumentsJson };
    return { argumentsJson: "[redacted invalid connected app tool arguments]" };
  }

  async function appendNativeToolStarted(
    session: Session,
    turnId: string,
    toolCall: NativeModelToolCall,
    args: Record<string, unknown>,
  ): Promise<void> {
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId,
        name: "tool.started",
        source: "provider",
        action: toolCall.name,
        appId: session.appId,
        args,
        status: "started",
        data: {
          toolCallId: toolCall.id,
          tool: toolCall.name,
          type: "native_model_tool",
        },
      }),
    );
  }

  async function appendNativeToolCompleted(
    session: Session,
    turnId: string,
    result: NativeModelToolResult,
  ): Promise<void> {
    const resourceRefs = nativeToolResultResourceRefs(result);
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId,
        name: "tool.completed",
        source: "provider",
        action: result.name,
        appId: session.appId,
        status: result.ok ? "completed" : "failed",
        output: result.contentText,
        error: result.ok ? undefined : result.contentText,
        data: {
          toolCallId: result.toolCallId,
          tool: result.name,
          type: "native_model_tool",
          ...(resourceRefs.length > 0 ? { resourceRefs } : {}),
          result: result.data,
        },
      }),
    );
    if (result.name === "ask_user" && result.ok) {
      const data = result.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? result.data as Record<string, unknown>
        : {};
      const question = SessionUserQuestionSchema.parse({
        id: data.questionId,
        sessionId: session.id,
        turnId,
        toolCallId: result.toolCallId,
        question: data.question,
        reason: data.reason ?? null,
        options: data.options ?? [],
        allowFreeform: data.allowFreeform !== false,
        status: "pending",
        answer: null,
        createdAt: new Date().toISOString(),
        answeredAt: null,
      });
      await appendRuntimeEvent(
        event({
          sessionId: session.id,
          turnId,
          name: "user_question.asked",
          source: "provider",
          action: "ask_user",
          appId: session.appId,
          status: "pending",
          output: question.question,
          data: { question },
        }),
      );
    }
  }

  function nativeToolResultResourceRefs(result: NativeModelToolResult): string[] {
    const refs = new Set<string>();
    collectNativeToolResourceRefs(result.data, refs);
    return [...refs].slice(0, 50);
  }

  function collectNativeToolResourceRefs(value: unknown, refs: Set<string>): void {
    if (!value) return;
    if (typeof value === "string") {
      if (/^(workspace:(?:file|dir):|sandbox:(?:file|dir):|git:|event:|message:|artifact:|goal-context:)/.test(value)) {
        refs.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectNativeToolResourceRefs(item, refs);
      return;
    }
    if (typeof value !== "object") return;
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectNativeToolResourceRefs(child, refs);
    }
  }

  function failedNativeToolResult(toolCall: NativeModelToolCall, message: string): NativeModelToolResult {
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      ok: false,
      contentText: JSON.stringify(
        {
          ok: false,
          action: toolCall.name,
          output: message,
        },
        null,
        2,
      ),
    };
  }


  return {
    appendProfileSkillEvent,
    executeNativeToolCalls,
    explicitProfileSkillNames,
    profileSkillBodyFromReadResult,
    readProfileSkillForModel,
  };
}
