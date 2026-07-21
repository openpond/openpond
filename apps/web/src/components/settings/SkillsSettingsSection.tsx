import {
  CONNECTED_APP_INTEGRATION_SKILLS,
  connectedAppBundleByProvider,
  type ConnectedAppIntegrationSkill,
} from "@openpond/contracts";
import { ChevronRight, FileText } from "../icons";
import "../../styles/settings/skills-settings.css";

export function SkillsSettingsSection({
  onOpenNativeSkill,
}: {
  onOpenNativeSkill: (skill: ConnectedAppIntegrationSkill) => void;
}) {
  return (
    <section className="account-settings skills-settings" aria-labelledby="skills-settings-title">
      <header className="skills-settings-header">
        <div>
          <h1 id="skills-settings-title">Skills</h1>
          <p>
            Read-only operating instructions that ship with OpenPond and are loaded when an agent uses the matching app.
          </p>
        </div>
      </header>

      <div className="account-list native-skills-list">
        <div className="account-list-heading">
          <span>Native skills</span>
          <small>Bundled with this OpenPond build</small>
        </div>
        {CONNECTED_APP_INTEGRATION_SKILLS.map((skill) => {
          const providerLabel = connectedAppBundleByProvider(skill.provider)?.label ?? skill.provider;
          return (
            <button
              className="native-skill-row"
              key={skill.name}
              type="button"
              onClick={() => onOpenNativeSkill(skill)}
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
