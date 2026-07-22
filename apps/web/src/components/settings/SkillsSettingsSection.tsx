import {
  CONNECTED_APP_INTEGRATION_SKILLS,
  connectedAppBundleByProvider,
  type CodexPersonalSkill,
  type OpenPondExtension,
  type OpenPondExtensionCatalog,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { ChevronRight, FileText } from "../icons";
import { GithubExtensionsSettings } from "./GithubExtensionsSettings";
import type { SkillSourceDocument } from "../app-shell/skill-source-document";
import "../../styles/settings/skills-settings.css";

export function SkillsSettingsSection({
  onOpenSkill,
  onOpenExtension,
  personalSkills,
  extensionCatalog,
  connection,
  onExtensionCatalog,
  onError,
  onToast,
}: {
  onOpenSkill: (skill: SkillSourceDocument) => void;
  onOpenExtension: (extension: OpenPondExtension) => void;
  personalSkills: CodexPersonalSkill[];
  extensionCatalog: OpenPondExtensionCatalog;
  connection: ClientConnection | null;
  onExtensionCatalog: (catalog: OpenPondExtensionCatalog) => void;
  onError: (message: string | null) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
}) {
  return (
    <section className="account-settings skills-settings" aria-labelledby="skills-settings-title">
      <header className="skills-settings-header">
        <div>
          <h1 id="skills-settings-title">Skills</h1>
          <p>
            Install third-party GitHub packs, inspect personal Codex skills, and view instructions bundled with OpenPond.
          </p>
        </div>
      </header>

      <GithubExtensionsSettings
        catalog={extensionCatalog}
        connection={connection}
        onCatalog={onExtensionCatalog}
        onError={onError}
        onOpenExtension={onOpenExtension}
        onToast={onToast}
      />

      <div className="account-list native-skills-list">
        <div className="account-list-heading">
          <span>Personal Codex skills</span>
          <small>Discovered from your local Codex skills folder</small>
        </div>
        {personalSkills.length ? personalSkills.map((skill) => (
          <div className="native-skill-row personal-skill-row" key={skill.sourcePath}>
            <span className="native-skill-icon" aria-hidden="true">
              <FileText size={17} />
            </span>
            <span className="native-skill-identity">
              <strong>{skill.name}</strong>
              <span>{skill.description || "Packaged Codex skill"}</span>
            </span>
            <span className="native-skill-provider">
              <strong>
                {skill.resourceFiles.length
                  ? `${skill.resourceFiles.length} packaged resource${skill.resourceFiles.length === 1 ? "" : "s"}`
                  : "Instructions only"}
              </strong>
              <span>{skill.sourcePath}</span>
            </span>
            <span className={`native-skill-status ${skill.validationStatus === "valid" ? "" : "invalid"}`}>
              {skill.validationStatus === "valid" ? "Ready" : "Needs attention"}
            </span>
            <span aria-hidden="true" />
          </div>
        )) : (
          <div className="skills-settings-empty">No personal Codex skills found.</div>
        )}
      </div>

      <div className="account-list native-skills-list">
        <div className="account-list-heading">
          <span>App integration skills</span>
          <small>Bundled with this OpenPond build</small>
        </div>
        {CONNECTED_APP_INTEGRATION_SKILLS.map((skill) => {
          const providerLabel = connectedAppBundleByProvider(skill.provider)?.label ?? skill.provider;
          return (
            <button
              className="native-skill-row"
              key={skill.name}
              type="button"
              onClick={() => onOpenSkill(skill)}
            >
              <span className="native-skill-icon" aria-hidden="true">
                <FileText size={17} />
              </span>
              <span className="native-skill-identity">
                <strong>{skill.name}</strong>
                <span>{skill.description}</span>
              </span>
              <span className="native-skill-provider">
                <strong>{providerLabel}</strong>
                <span>{skill.path}</span>
              </span>
              <span className="native-skill-status">Built in</span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
