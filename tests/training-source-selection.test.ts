import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("Training source selection UI", () => {
  test("supports per-chat and batched Manual or Automated selection", async () => {
    const [rows, view, dialog, hook] = await Promise.all([
      readFile("apps/web/src/components/sidebar/SidebarRows.tsx", "utf8"),
      readFile("apps/web/src/components/training/TrainingView.tsx", "utf8"),
      readFile("apps/web/src/components/training/TrainingRunDialog.tsx", "utf8"),
      readFile("apps/web/src/hooks/useTraining.ts", "utf8"),
    ]);
    expect(rows).toContain('label="Add to training"');
    expect(view).toContain("New model");
    expect(dialog).toContain('type RunMode = "manual" | "automated"');
    expect(dialog).toContain("selectedSessionIds");
    expect(dialog).toContain("addSources(missingSessionIds)");
    expect(dialog).toContain("Search selected chats");
    expect(dialog.indexOf('>Automated</button>')).toBeLessThan(dialog.indexOf('>Manual</button>'));
    expect(dialog).toContain("CodexModelReasoningMenu");
    expect(dialog).toContain("configureMiner(nextConfig)");
    expect(dialog).toContain("estimateSources");
    expect(dialog).toContain("About {formatTokens");
    expect(dialog).not.toContain(" · ");
    expect(dialog).toContain('className="training-chat-checkbox"');
    expect(dialog).not.toContain("The scan stays local and opens reviewable suggestions.");
    expect(dialog).not.toContain("Choose the conversations that define this training workflow.");
    expect(hook).toContain('"/sources/batch"');
    expect(hook).toContain('"/sources/estimate"');
  });
});
