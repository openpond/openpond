import type { FormEvent } from "react";
import type { PersonalizationTemplate, PersonalizationTemplateId } from "@openpond/contracts";
import { Check, Plus, RotateCcw, Save, X } from "../icons";
import { DropdownSelect } from "../DropdownSelect";
import type { DropdownOption } from "../../lib/app-models";

type PersonalizationSettingsSectionProps = {
  canSaveCurrentTemplate: boolean;
  personalizationTemplateId: PersonalizationTemplateId;
  personalizationTemplateOptions: DropdownOption[];
  saveAsNewOpen: boolean;
  saving: boolean;
  selectedPersonalizationTemplate: PersonalizationTemplate | undefined;
  selectedTemplateIsCustom: boolean;
  soulDraft: string;
  templateNameDraft: string;
  changePersonalizationTemplate: (templateId: string) => void;
  changeSoulDraft: (value: string) => void;
  openSaveAsNew: () => void;
  resetPersonalizationDraft: () => void;
  savePersonalization: (saveAsNew?: boolean) => Promise<void>;
  setSaveAsNewOpen: (open: boolean) => void;
  setTemplateNameDraft: (value: string) => void;
};

export function PersonalizationSettingsSection({
  canSaveCurrentTemplate,
  personalizationTemplateId,
  personalizationTemplateOptions,
  saveAsNewOpen,
  saving,
  selectedPersonalizationTemplate,
  selectedTemplateIsCustom,
  soulDraft,
  templateNameDraft,
  changePersonalizationTemplate,
  changeSoulDraft,
  openSaveAsNew,
  resetPersonalizationDraft,
  savePersonalization,
  setSaveAsNewOpen,
  setTemplateNameDraft,
}: PersonalizationSettingsSectionProps) {
  function submitPersonalization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void savePersonalization(saveAsNewOpen);
  }

  return (
    <section className="account-settings">
      <h1>Personalization</h1>
      <form className="provider-settings-form personalization-form" onSubmit={submitPersonalization}>
        <div className="account-list-heading">
          <span>Agent style</span>
          <div className="settings-heading-actions">
            {saveAsNewOpen ? (
              <>
                <input
                  className="settings-heading-input"
                  value={templateNameDraft}
                  onChange={(event) => setTemplateNameDraft(event.target.value)}
                  placeholder="Name"
                  aria-label="Template name"
                />
                <button
                  type="button"
                  className="settings-icon-button"
                  title="Cancel"
                  aria-label="Cancel"
                  disabled={saving}
                  onClick={() => setSaveAsNewOpen(false)}
                >
                  <X size={15} />
                </button>
                <button
                  type="button"
                  className="settings-icon-button primary"
                  title="Save new template"
                  aria-label="Save new template"
                  disabled={saving || !soulDraft.trim() || !templateNameDraft.trim()}
                  onClick={() => void savePersonalization(true)}
                >
                  <Check size={15} />
                </button>
              </>
            ) : (
              <>
                <small>{selectedTemplateIsCustom ? "Custom template" : "Built-in template"}</small>
                <button
                  type="button"
                  className="settings-icon-button"
                  title="Save as new"
                  aria-label="Save as new"
                  disabled={saving || !selectedPersonalizationTemplate || !soulDraft.trim()}
                  onClick={openSaveAsNew}
                >
                  <Plus size={15} />
                </button>
              </>
            )}
          </div>
        </div>
        <div className="provider-settings-grid single">
          <div className="settings-select-field">
            <span>Template</span>
            <DropdownSelect
              value={personalizationTemplateId}
              disabled={saving || personalizationTemplateOptions.length === 0}
              label="Personalization template"
              options={personalizationTemplateOptions}
              onChange={(value) => void changePersonalizationTemplate(value)}
            />
          </div>
        </div>
        <label className="settings-select-field personalization-editor">
          <span>SOUL.md</span>
          <textarea value={soulDraft} onChange={(event) => changeSoulDraft(event.target.value)} spellCheck={false} />
        </label>
        <div className="settings-button-row">
          <button
            type="button"
            className="settings-icon-button"
            title="Reset to template"
            aria-label="Reset to template"
            disabled={saving || !selectedPersonalizationTemplate}
            onClick={resetPersonalizationDraft}
          >
            <RotateCcw size={15} />
          </button>
          {selectedTemplateIsCustom && (
            <button
              className="settings-icon-button primary"
              title="Save template"
              aria-label="Save template"
              disabled={saving || !canSaveCurrentTemplate}
            >
              <Save size={15} />
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
