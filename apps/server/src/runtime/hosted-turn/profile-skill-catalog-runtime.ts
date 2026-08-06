import type {
  ChatProvider,
  OpenPondExtensionCatalog,
  OpenPondProfileSkill,
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
  loadProfileState?: ((session: Session) => Promise<OpenPondProfileState>) | null;
  readProfileSkill?: ((input: { profileSourcePath: string; name: string }) => Promise<ProfileSkillReadResult>) | null;
  loadBuiltInSkills?: (() => Promise<OpenPondProfileSkill[]>) | null;
  readBuiltInSkill?: ((name: string) => Promise<ProfileSkillReadResult>) | null;
  loadExtensionCatalog?: (() => Promise<OpenPondExtensionCatalog>) | null;
  readExtensionSkill?: ((name: string) => Promise<ProfileSkillReadResult>) | null;
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
  const loadBuiltInSkills = deps.loadBuiltInSkills;
  const readBuiltInSkill = deps.readBuiltInSkill;
  const loadOpenPondExtensionCatalog = deps.loadExtensionCatalog;
  const readOpenPondExtensionSkill = deps.readExtensionSkill;
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
    profile?: OpenPondProfileState | null;
    harnessRuntime?: ProfileSkillRuntime | null;
  }): Promise<ProfileSkillRuntime> {
    const harnessRuntime = input.harnessRuntime ?? null;
    const [builtInResult, profileResult, extensionResult] = await Promise.allSettled([
      loadBuiltInSkills && readBuiltInSkill
        ? loadBuiltInSkills()
        : Promise.resolve([]),
      harnessRuntime
        ? Promise.resolve(null)
        : input.profile
        ? Promise.resolve(input.profile)
        : loadOpenPondProfileState && readOpenPondProfileSkill
          ? loadOpenPondProfileState(input.session)
        : Promise.resolve(null),
      loadOpenPondExtensionCatalog && readOpenPondExtensionSkill
        ? loadOpenPondExtensionCatalog()
        : Promise.resolve(null),
    ]);
    const builtInSkills = builtInResult.status === "fulfilled" ? builtInResult.value : [];
    const profile = profileResult.status === "fulfilled" ? profileResult.value : null;
    const extensionCatalog = extensionResult.status === "fulfilled" ? extensionResult.value : null;
    if (builtInResult.status === "rejected") {
      await appendSkillCatalogDiagnostic(input, "built-in", builtInResult.reason);
    }
    if (profileResult.status === "rejected") {
      await appendSkillCatalogDiagnostic(input, "profile", profileResult.reason);
    } else if (profile?.error) {
      await appendSkillCatalogDiagnostic(input, "profile", profile.error);
    }
    if (extensionResult.status === "rejected") {
      await appendSkillCatalogDiagnostic(input, "extension", extensionResult.reason);
    } else if (extensionCatalog?.error) {
      await appendSkillCatalogDiagnostic(input, "extension", extensionCatalog.error);
    }

    const skills: OpenPondProfileSkill[] = [];
    const readers = new Map<string, () => Promise<ProfileSkillReadResult>>();
    if (readBuiltInSkill) {
      for (const skill of builtInSkills) {
        if (!skill.enabled || skill.validationStatus !== "valid") continue;
        skills.push(skill);
        readers.set(skill.name, () => readBuiltInSkill(skill.name));
      }
    }
    if (harnessRuntime?.readSkill) {
      for (const skill of harnessRuntime.skills) {
        if (!skill.enabled || skill.validationStatus !== "valid" || readers.has(skill.name)) continue;
        skills.push(skill);
        readers.set(skill.name, () => harnessRuntime.readSkill!(skill.name));
      }
    }
    if (profile?.sourcePath && !profile.error && readOpenPondProfileSkill) {
      for (const skill of profile.skills) {
        if (!skill.enabled || skill.validationStatus !== "valid" || readers.has(skill.name)) continue;
        skills.push(skill);
        readers.set(skill.name, () => readOpenPondProfileSkill({
          profileSourcePath: profile.sourcePath!,
          name: skill.name,
        }));
      }
    }
    if (extensionCatalog && !extensionCatalog.error && readOpenPondExtensionSkill) {
      for (const extension of extensionCatalog.extensions) {
        if (extension.validationStatus !== "valid") continue;
        for (const skill of extension.skills) {
          if (skill.validationStatus !== "valid" || readers.has(skill.name)) continue;
          skills.push({
            name: skill.name,
            description: skill.description,
            path: skill.relativePath,
            scope: "profile",
            enabled: true,
            sourcePath: extension.sourcePath,
            charCount: skill.charCount,
            sourceHash: skill.sourceHash,
            validationStatus: "valid",
            validationMessages: [],
            resourceFiles: skill.resourceFiles,
          });
          readers.set(skill.name, () => readOpenPondExtensionSkill(skill.name));
        }
      }
    }
    skills.sort((left, right) => left.name.localeCompare(right.name));
    return {
      profileSourcePath: profile?.sourcePath ?? null,
      skills,
      readSkill: readers.size > 0
        ? (name) => {
            const read = readers.get(name);
            if (!read) throw new Error(`OpenPond harness skill not found: ${name}`);
            return read();
          }
        : null,
    };
  }

  async function appendSkillCatalogDiagnostic(
    input: { session: Session; turnId: string },
    kind: "built-in" | "profile" | "extension",
    error: unknown,
  ): Promise<void> {
    await appendRuntimeEvent(
      event({
        sessionId: input.session.id,
        turnId: input.turnId,
        name: "diagnostic",
        source: "server",
        appId: input.session.appId,
        status: "failed",
        output: `Failed to load OpenPond ${kind} skills: ${textFromUnknown(error) || "Unknown error"}`,
      }),
    );
  }

  async function preloadExplicitProfileSkills(input: {
    session: Session;
    turnId: string;
    prompt: string;
    selectedSkillNames?: readonly string[];
    runtime: ProfileSkillRuntime;
    signal: AbortSignal;
  }): Promise<HostedProfileSkillBody[]> {
    const requiredNames = input.selectedSkillNames ?? [];
    if (!input.runtime.readSkill || input.runtime.skills.length === 0) {
      if (requiredNames.length > 0) {
        throw new Error(`Required bundled authoring skill is unavailable: ${requiredNames.join(", ")}`);
      }
      return [];
    }
    const skillByName = new Map(input.runtime.skills.map((skill) => [skill.name, skill]));
    const missingRequired = requiredNames.filter((name) => !skillByName.has(name));
    if (missingRequired.length > 0) {
      throw new Error(`Required bundled authoring skill is unavailable: ${missingRequired.join(", ")}`);
    }
    const names = [
      ...(input.selectedSkillNames ?? []),
      ...explicitProfileSkillNames(input.prompt),
    ].filter((name, index, all) => skillByName.has(name) && all.indexOf(name) === index);
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
        if (requiredNames.includes(name)) throw error;
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
