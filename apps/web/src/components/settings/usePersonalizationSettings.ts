import { useEffect, useMemo, useState } from "react";
import type {
  BootstrapPayload,
  PersonalizationSettings,
  PersonalizationTemplateId,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";

export function usePersonalizationSettings({
  connection,
  onError,
  onPayload,
  personalization,
}: {
  connection: ClientConnection | null;
  onError: (message: string | null) => void;
  onPayload: (payload: BootstrapPayload) => void;
  personalization: PersonalizationSettings;
}) {
  const personalizationTemplateOptions = useMemo(
    () =>
      personalization.templates.map((template) => ({
        value: template.id,
        label: template.name,
        description:
          template.id === personalization.activeTemplateId
            ? "Selected"
            : template.source === "built_in"
              ? template.description
              : undefined,
      })),
    [personalization.activeTemplateId, personalization.templates]
  );
  const [personalizationTemplateId, setPersonalizationTemplateId] = useState<PersonalizationTemplateId>(
    personalization.activeTemplateId
  );
  const [soulDraft, setSoulDraft] = useState(personalization.soul);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [saveAsNewOpen, setSaveAsNewOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const selectedPersonalizationTemplate =
    personalization.templates.find((template) => template.id === personalizationTemplateId) ??
    personalization.templates[0];
  const selectedTemplateIsCustom = selectedPersonalizationTemplate?.source === "custom";
  const soulDirty = selectedPersonalizationTemplate ? soulDraft !== selectedPersonalizationTemplate.content : true;
  const personalizationDirty =
    personalizationTemplateId !== personalization.activeTemplateId ||
    soulDraft !== personalization.soul ||
    soulDirty;
  const canSaveCurrentTemplate = Boolean(
    selectedTemplateIsCustom && soulDraft.trim() && selectedPersonalizationTemplate && personalizationDirty
  );

  useEffect(() => {
    setPersonalizationTemplateId(personalization.activeTemplateId);
    setSoulDraft(personalization.soul);
    const activeTemplate = personalization.templates.find((template) => template.id === personalization.activeTemplateId);
    setTemplateNameDraft(activeTemplate ? `${activeTemplate.name} Copy` : "");
    setSaveAsNewOpen(false);
  }, [personalization.activeTemplateId, personalization.soul, personalization.templates]);

  async function savePersonalization(saveAsNew = false) {
    if (!saveAsNew && !selectedTemplateIsCustom) return;
    const templateName = saveAsNew ? templateNameDraft : selectedPersonalizationTemplate?.name;
    if (!connection || !soulDraft.trim() || !templateName?.trim()) return;
    setSaving(true);
    onError(null);
    try {
      onPayload(
        await api.savePersonalization(connection, {
          activeTemplateId: personalizationTemplateId,
          templateName,
          soul: soulDraft,
          saveAsNew,
        })
      );
      setSaveAsNewOpen(false);
    } catch (saveError) {
      onError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function changePersonalizationTemplate(templateId: string) {
    const template = personalization.templates.find((candidate) => candidate.id === templateId);
    if (!template) return;
    setPersonalizationTemplateId(template.id);
    setTemplateNameDraft(`${template.name} Copy`);
    setSoulDraft(template.content);
    setSaveAsNewOpen(false);
    if (!connection) return;
    setSaving(true);
    onError(null);
    try {
      onPayload(
        await api.savePersonalization(connection, {
          activeTemplateId: template.id,
          templateName: template.name,
          soul: template.content,
          saveAsNew: false,
        })
      );
    } catch (selectError) {
      onError(selectError instanceof Error ? selectError.message : String(selectError));
    } finally {
      setSaving(false);
    }
  }

  function resetPersonalizationDraft() {
    if (!selectedPersonalizationTemplate) return;
    setTemplateNameDraft(`${selectedPersonalizationTemplate.name} Copy`);
    setSoulDraft(selectedPersonalizationTemplate.content);
    setSaveAsNewOpen(false);
  }

  function changeSoulDraft(value: string) {
    setSoulDraft(value);
    if (!selectedPersonalizationTemplate) return;
    if (!selectedTemplateIsCustom && value !== selectedPersonalizationTemplate.content) {
      setSaveAsNewOpen(true);
    }
  }

  function openSaveAsNew() {
    if (!selectedPersonalizationTemplate) return;
    setTemplateNameDraft(`${selectedPersonalizationTemplate.name} Copy`);
    setSaveAsNewOpen(true);
  }

  return {
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
  };
}
