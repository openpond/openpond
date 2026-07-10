import type {
  ChatProvider,
  OpenPondProfileState,
  RuntimeEvent,
  Session,
} from "@openpond/contracts";
import type {
  HostedProfileSkillBody,
  ProfileSkillInstructionMode,
} from "../../openpond/hosted-turn-helpers.js";
import type { ProfileSkillReadResult } from "../../openpond/model-tool-registry.js";
import type { ProfileSkillRuntime } from "./native-tools-runtime.js";
import {
  hostedToolInstructionModeForProvider,
  type HostedToolRolloutFlags,
} from "./rollout.js";
import { event, textFromUnknown } from "../../utils.js";

export function createProfileSkillCatalogRuntime(deps: {
  loadProfileState?: (() => Promise<OpenPondProfileState>) | null;
  readProfileSkill?: ((input: { profileSourcePath: string; name: string }) => Promise<ProfileSkillReadResult>) | null;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  nativeToolsEnabledForProvider(provider: ChatProvider): boolean;
  hostedToolFlags: HostedToolRolloutFlags;
  appendProfileSkillEvent(input: {
    session: Session;
    turnId: string;
    eventName: "skill.selected" | "skill.loaded" | "skill.load_failed";
    status: "completed" | "failed";
    output: string;
    skillName: string;
    skill?: ProfileSkillReadResult | HostedProfileSkillBody | null;
    source: "provider" | "server";
  }): Promise<void>;
  explicitProfileSkillNames(prompt: string): string[];
  profileSkillBodyFromReadResult(skill: ProfileSkillReadResult): HostedProfileSkillBody;
  throwIfInterrupted(signal: AbortSignal): void;
}) {
  const loadOpenPondProfileState = deps.loadProfileState;
  const readOpenPondProfileSkill = deps.readProfileSkill;
  const appendRuntimeEvent = deps.appendRuntimeEvent;
  const nativeToolsEnabledForProvider = deps.nativeToolsEnabledForProvider;
  const hostedToolFlags = deps.hostedToolFlags;
  const appendProfileSkillEvent = deps.appendProfileSkillEvent;
  const explicitProfileSkillNames = deps.explicitProfileSkillNames;
  const profileSkillBodyFromReadResult = deps.profileSkillBodyFromReadResult;
  const throwIfInterrupted = deps.throwIfInterrupted;
  function profileSkillInstructionModeForProvider(
    provider: ChatProvider,
    runtime: ProfileSkillRuntime,
  ): ProfileSkillInstructionMode {
    if (runtime.skills.length === 0 || !runtime.readSkill) return "none";
    if (nativeToolsEnabledForProvider(provider)) return "native_tool";
    if (hostedToolInstructionModeForProvider(hostedToolFlags, provider) === "full_text_fallback") return "text_fallback";
    return "none";
  }

  async function loadProfileSkillRuntime(input: {
    session: Session;
    turnId: string;
  }): Promise<ProfileSkillRuntime> {
    if (!loadOpenPondProfileState || !readOpenPondProfileSkill) {
      return { profileSourcePath: null, skills: [], readSkill: null };
    }
    try {
      const profile = await loadOpenPondProfileState();
      if (profile.error || !profile.sourcePath) {
        return { profileSourcePath: profile.sourcePath, skills: [], readSkill: null };
      }
      const skills = profile.skills
        .filter((skill) => skill.enabled && skill.validationStatus === "valid")
        .sort((left, right) => left.name.localeCompare(right.name));
      return {
        profileSourcePath: profile.sourcePath,
        skills,
        readSkill: (name) => readOpenPondProfileSkill({ profileSourcePath: profile.sourcePath!, name }),
      };
    } catch (error) {
      await appendRuntimeEvent(
        event({
          sessionId: input.session.id,
          turnId: input.turnId,
          name: "diagnostic",
          source: "server",
          appId: input.session.appId,
          status: "failed",
          output: `Failed to load OpenPond profile skills: ${textFromUnknown(error) || "Unknown error"}`,
        }),
      );
      return { profileSourcePath: null, skills: [], readSkill: null };
    }
  }

  async function preloadExplicitProfileSkills(input: {
    session: Session;
    turnId: string;
    prompt: string;
    runtime: ProfileSkillRuntime;
    signal: AbortSignal;
  }): Promise<HostedProfileSkillBody[]> {
    if (!input.runtime.readSkill || input.runtime.skills.length === 0) return [];
    const skillByName = new Map(input.runtime.skills.map((skill) => [skill.name, skill]));
    const names = explicitProfileSkillNames(input.prompt).filter((name) => skillByName.has(name));
    const loaded: HostedProfileSkillBody[] = [];
    for (const name of names.slice(0, 5)) {
      throwIfInterrupted(input.signal);
      await appendProfileSkillEvent({
        session: input.session,
        turnId: input.turnId,
        eventName: "skill.selected",
        status: "completed",
        output: `Selected profile skill ${name}.`,
        skillName: name,
        source: "server",
      });
      try {
        const skill = await input.runtime.readSkill(name);
        loaded.push(profileSkillBodyFromReadResult(skill));
        await appendProfileSkillEvent({
          session: input.session,
          turnId: input.turnId,
          eventName: "skill.loaded",
          status: "completed",
          output: `Loaded profile skill ${name}.`,
          skillName: name,
          skill,
          source: "server",
        });
      } catch (error) {
        await appendProfileSkillEvent({
          session: input.session,
          turnId: input.turnId,
          eventName: "skill.load_failed",
          status: "failed",
          output: textFromUnknown(error) || `Failed to load profile skill ${name}.`,
          skillName: name,
          source: "server",
        });
      }
    }
    return loaded;
  }


  return {
    loadProfileSkillRuntime,
    preloadExplicitProfileSkills,
    profileSkillInstructionModeForProvider,
  };
}
