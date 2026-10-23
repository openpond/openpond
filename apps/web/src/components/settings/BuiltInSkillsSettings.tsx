import { useEffect, useRef, useState } from "react";
import type { OpenPondProfileSkill } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import type { SkillSourceDocument } from "../app-shell/skill-source-document";
import { useErrorToast } from "../../app/AppToastContext";

export function BuiltInSkillsSettings({
  skills,
  connection,
  onOpenSkill,
}: {
  skills: OpenPondProfileSkill[];
  connection: ClientConnection | null;
  onOpenSkill: (skill: SkillSourceDocument) => void;
}) {
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useErrorToast(error);
  useEffect(() => {
    generation.current++;
    setOpening(null);
    return () => {
      generation.current++;
    };
  }, [connection]);

  async function open(skill: OpenPondProfileSkill) {
    if (!connection || opening) return;
    const request = ++generation.current;
    setOpening(skill.name);
    setError(null);
    try {
      const files = await Promise.all(
        ["SKILL.md", ...skill.resourceFiles].map(async (path) => {
          const source = await api.skillSourceFile(connection, "builtin", skill.name, path);
          if (source.isBinary || source.content === null)
            throw new Error("This skill file cannot be displayed as text.");
          return { path, body: source.content };
        }),
      );
      if (generation.current === request)
        onOpenSkill({
          name: skill.name,
          description: skill.description,
          path: skill.path,
          body: files[0]!.body,
          files,
        });
    } catch (cause) {
      if (generation.current === request)
        setError(cause instanceof Error ? cause.message : "Could not open this skill.");
    } finally {
      if (generation.current === request) setOpening(null);
    }
  }

  return (
    <div className="account-list native-skills-list">
      <div className="account-list-heading">
        <span>OpenPond skills</span>
        <small>Included and enabled automatically with Desktop</small>
      </div>
      <div className="profile-table-frame">
        <table
          className="profile-data-table built-in-skills-table"
          aria-label="Built-in OpenPond skills"
        >
          <thead>
            <tr>
              <th scope="col">Skill</th>
              <th scope="col">Purpose</th>
              <th scope="col">Status</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((skill) => (
              <tr key={skill.name}>
                <td>
                  <strong>{skill.name}</strong>
                </td>
                <td>{skill.description}</td>
                <td>
                  {skill.enabled && skill.validationStatus === "valid"
                    ? "Ready · Built in"
                    : "Needs repair"}
                </td>
                <td>
                  <button
                    className="settings-secondary compact"
                    type="button"
                    disabled={!connection || !!opening || skill.validationStatus !== "valid"}
                    onClick={() => void open(skill)}
                    aria-label={`Open ${skill.name} instructions`}
                  >
                    {opening === skill.name ? "Opening…" : "Open"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
