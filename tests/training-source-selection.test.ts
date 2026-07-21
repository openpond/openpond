import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";

describe("Training source selection UI", () => {
  test("supports intent-first flow followed by compact shared evidence selection", async () => {
    const [rows, view, labs, pane, dialog, flow, startStep, sourceStep, chatPicker, hook] = await Promise.all([
      readFile("apps/web/src/components/sidebar/SidebarRows.tsx", "utf8"),
      readFile("apps/web/src/components/training/TrainingView.tsx", "utf8"),
      readFile("apps/web/src/components/labs/LabsView.tsx", "utf8"),
      readFile("apps/web/src/components/app-shell/MainPane.tsx", "utf8"),
      readFile("apps/web/src/components/create-improve/CreateImproveAuthoringDialog.tsx", "utf8"),
      readFile("apps/web/src/components/training/training-flow.ts", "utf8"),
      readFile("apps/web/src/components/training/TrainingStartModeStep.tsx", "utf8"),
      readFile("apps/web/src/components/training/TrainingSourceStep.tsx", "utf8"),
      readFile("apps/web/src/components/training/TrainingChatPicker.tsx", "utf8"),
      readFile("apps/web/src/hooks/useTraining.ts", "utf8"),
    ]);
    expect(rows).toContain('label="Add to training"');
    expect(view).not.toContain("New model");
    expect(labs).toContain("onCreateModel");
    expect(pane).toContain("setTrainingLaunchRequest");
    expect(pane).toContain("onNewModel");
    expect(startStep).toContain('type NewModelMode = "automated" | "manual"');
    expect(startStep).toContain('type AgentSourceMode = "from_prompt" | "from_chats"');
    expect(startStep).toContain('NewModelMode | AgentSourceMode | "existing_dataset"');
    expect(flow).toContain('type NewModelStep =');
    for (const step of ["start", "base_model", "existing_dataset", "automatic_scope", "automatic_candidates", "evidence", "recommendation"]) expect(flow).toContain(`| "${step}"`);
    expect(flow).not.toContain("manual_goal");
    expect(dialog).toContain("selectedSessionIds");
    expect(dialog).toContain("addSources(missingSessionIds)");
    expect(dialog).toContain("const sessionIds = [...selectedSessionIds]");
    expect(dialog).toContain("runMiner(");
    expect(dialog).not.toContain("eligibleSessions.map((session) => session.id),");
    expect(startStep).toContain("Choose a setup");
    expect(startStep).toContain("Automatic");
    expect(startStep).toContain("Manual");
    expect(startStep).toContain("Existing Dataset");
    expect(sourceStep).toContain("Build the Dataset");
    expect(sourceStep).toContain("onObjectiveChange");
    expect(sourceStep).toContain("required");
    expect(sourceStep).toContain('className="training-manual-chat-seeds"');
    expect(sourceStep).toContain("Add supporting chats");
    expect(sourceStep).toContain("Optional");
    expect(dialog).not.toContain("methodHintForApproach");
    expect(sourceStep).toContain("CodexModelReasoningMenu");
    expect(chatPicker).toContain('placeholder="Search chats"');
    expect(dialog).toContain("CHAT_SEARCH_PAGE_SIZE = 20");
    expect(dialog).toContain("searchChats(search, chatSearchCandidates, offset, CHAT_SEARCH_PAGE_SIZE)");
    expect(chatPicker).toContain("onScroll");
    expect(chatPicker).toContain("training-chat-search-snippet");
    expect(chatPicker).toContain("Indexing messages");
    expect(sourceStep).not.toContain("trainingApproachLabel");
    expect(sourceStep).toContain("Dataset purpose");
    expect(dialog).toContain("estimateSources");
    expect(sourceStep).toContain("About {formatTrainingTokens");
    expect(sourceStep).not.toContain(" · ");
    expect(chatPicker).toContain('className="training-chat-checkbox"');
    expect(sourceStep).not.toContain(">Back</button>");
    expect(dialog).not.toContain("cancelCreation(creation.id)");
    expect(hook).toContain('"/sources/batch"');
    expect(hook).toContain('"/sources/estimate"');
    expect(hook).toContain('"/sources/search"');
    expect(hook).toContain('"/models/from-taskset"');
    expect(hook).toContain('TaskCreationRequest["methodHint"]');
  });
});
