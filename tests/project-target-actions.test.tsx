import { createElement, type Dispatch, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { ChatProvider } from "@openpond/contracts";

import type { AppAction } from "../apps/web/src/app/app-state";
import { ComposerProjectTargetControl } from "../apps/web/src/components/chat/ComposerControls";
import { COMPOSER_PROJECT_ACTION_OPTIONS } from "../apps/web/src/hooks/useActiveWorkspaceViewState";
import { useProjectTargetActions } from "../apps/web/src/hooks/useProjectTargetActions";

describe("composer project actions", () => {
  test("keeps the Select Project trigger free of a hover tooltip", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerProjectTargetControl, {
        busy: false,
        placement: "top",
        state: {
          value: "none",
          label: "Select Project",
          detail: "Choose a project for local or cloud work",
          options: [],
          busy: false,
        },
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Project"');
    expect(markup).not.toContain("data-tooltip");
  });

  test("offers every project creation route removed from the sidebar", () => {
    expect(
      COMPOSER_PROJECT_ACTION_OPTIONS.map(({ value, label }) => ({
        value,
        label,
      }))
    ).toEqual([
      { value: "action:new-local-project", label: "New local project" },
      { value: "action:add-local-project", label: "Use existing folder" },
      {
        value: "action:add-local-project-path",
        label: "Use existing folder path",
      },
      { value: "action:new-cloud-project", label: "New cloud project" },
      {
        value: "action:create-cloud-environment",
        label: "Create cloud environment",
      },
    ]);
  });

  test("routes project picker actions to their dedicated flows", () => {
    const calls: string[] = [];
    let changeProjectTarget: ((target: string) => void) | null = null;

    function Harness() {
      changeProjectTarget = useProjectTargetActions({
        addProjectFolder: () => {
          calls.push("existing-folder");
        },
        addProjectFolderPath: async () => undefined,
        appDispatch: (() => undefined) as Dispatch<AppAction>,
        busy: false,
        cloudProjectById: new Map(),
        createCloudProjectFromScratch: async () => undefined,
        createProjectFromScratch: async () => undefined,
        expandProject: () => undefined,
        localProjectById: new Map(),
        newProjectBusy: false,
        newProjectMode: "local",
        newProjectName: "",
        newProjectPath: "",
        onCreateCloudEnvironment: () => {
          calls.push("cloud-environment");
        },
        onNewCloudProject: () => {
          calls.push("new-cloud");
        },
        onNewLocalProject: () => {
          calls.push("new-local");
        },
        onUseExistingFolderPath: () => {
          calls.push("existing-folder-path");
        },
        projectTargetValue: "none",
        setDiffPanelOpen: noopSetter<boolean>(),
        setDraftModel: noopSetter<string>(),
        setDraftProvider: noopSetter<ChatProvider>(),
        setError: noopSetter<string | null>(),
        setNewProjectBusy: noopSetter<boolean>(),
        setNewProjectDialogOpen: noopSetter<boolean>(),
        setNewProjectName: noopSetter<string>(),
        setNewProjectPath: noopSetter<string>(),
        showToast: () => undefined,
        workspaceBusy: false,
      }).changeProjectTarget;
      return null;
    }

    renderToStaticMarkup(createElement(Harness));
    if (!changeProjectTarget) throw new Error("Project target harness failed");

    changeProjectTarget("action:new-local-project");
    changeProjectTarget("action:add-local-project");
    changeProjectTarget("action:add-local-project-path");
    changeProjectTarget("action:new-cloud-project");
    changeProjectTarget("action:create-cloud-environment");

    expect(calls).toEqual([
      "new-local",
      "existing-folder",
      "existing-folder-path",
      "new-cloud",
      "cloud-environment",
    ]);
  });
});

function noopSetter<T>(): Dispatch<SetStateAction<T>> {
  return () => undefined;
}
