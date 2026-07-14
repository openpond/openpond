import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("Training source selection UI", () => {
  test("supports intent-first flow followed by compact shared evidence selection", async () => {
    const [rows, view, dialog, startStep, manualStep, sourceStep, hook] = await Promise.all([
      readFile("apps/web/src/components/sidebar/SidebarRows.tsx", "utf8"),
      readFile("apps/web/src/components/training/TrainingView.tsx", "utf8"),
      readFile("apps/web/src/components/training/TrainingRunDialog.tsx", "utf8"),
      readFile("apps/web/src/components/training/TrainingStartModeStep.tsx", "utf8"),
      readFile("apps/web/src/components/training/TrainingManualGoalStep.tsx", "utf8"),
      readFile("apps/web/src/components/training/TrainingSourceStep.tsx", "utf8"),
      readFile("apps/web/src/hooks/useTraining.ts", "utf8"),
    ]);
    expect(rows).toContain('label="Add to training"');
    expect(view).toContain("New model");
    expect(dialog).toContain('type NewModelMode = "automated" | "manual"');
    expect(dialog).toContain('type NewModelStep =');
    for (const step of ["start", "automatic_scope", "automatic_candidates", "manual_goal", "evidence", "recommendation"]) expect(dialog).toContain(`| "${step}"`);
    expect(dialog).toContain("selectedSessionIds");
    expect(dialog).toContain("addSources(missingSessionIds)");
    expect(startStep).toContain("How do you want to start?");
    expect(startStep).toContain("Automated");
    expect(startStep).toContain("Manual");
    expect(manualStep).toContain("What should the model learn?");
    expect(manualStep).toContain("required");
    expect(dialog).not.toContain("methodHintForApproach");
    expect(dialog).not.toContain("TrainingMethodStep");
    expect(sourceStep).toContain("CodexModelReasoningMenu");
    expect(sourceStep).toContain('placeholder="Search chats"');
    expect(dialog).toContain("CHAT_SEARCH_PAGE_SIZE = 20");
    expect(dialog).toContain("searchChats(search, chatSearchCandidates, offset, CHAT_SEARCH_PAGE_SIZE)");
    expect(sourceStep).toContain("onScroll");
    expect(sourceStep).toContain("training-chat-search-snippet");
    expect(sourceStep).toContain("Indexing messages");
    expect(sourceStep).not.toContain("trainingApproachLabel");
    expect(sourceStep).not.toContain("What should the model learn?");
    expect(dialog).toContain("estimateSources");
    expect(sourceStep).toContain("About {formatTokens");
    expect(sourceStep).not.toContain(" · ");
    expect(sourceStep).toContain('className="training-chat-checkbox"');
    expect(sourceStep).not.toContain(">Back</button>");
    expect(dialog).not.toContain("cancelCreation(creation.id)");
    expect(hook).toContain('"/sources/batch"');
    expect(hook).toContain('"/sources/estimate"');
    expect(hook).toContain('"/sources/search"');
    expect(hook).toContain('TaskCreationRequest["methodHint"]');
  });
});
