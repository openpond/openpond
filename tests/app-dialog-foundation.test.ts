import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("shared app dialog foundation", () => {
  test("owns focus, inert background, nested Escape, and dismissal policy", async () => {
    const source = await readFile(
      "apps/web/src/components/dialogs/AppDialog.tsx",
      "utf8",
    );

    expect(source).toContain("dialogStack.at(-1)");
    expect(source).toContain("trapTabFocus");
    expect(source).toContain("makeBackgroundInert");
    expect(source).toContain("sibling.inert = true");
    expect(source).toContain('sibling.setAttribute("aria-hidden", "true")');
    expect(source).toContain("previousFocus?.isConnected");
    expect(source).toContain("dismissDisabledRef.current");
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain('event.key !== "Tab"');
    expect(source).toContain('closest<HTMLElement>(".main-pane")');
    expect(source).toContain("inertExclusionSelector");
    expect(source).toContain("sibling.matches(exclusionSelector)");
    expect(source).toContain("aria-modal={contained ? undefined : \"true\"}");
    expect(source).toContain('event.key !== "Tab" || contained');
  });

  test("backs every scoped Lab dialog with the shared primitive", async () => {
    const paths = [
      "apps/web/src/components/create-improve/CreateImproveAuthoringShell.tsx",
      "apps/web/src/components/datasets/DatasetSourcePickerDialog.tsx",
      "apps/web/src/components/datasets/HuggingFaceDatasetImportDialog.tsx",
      "apps/web/src/components/labs/LabNewVersionDialog.tsx",
      "apps/web/src/components/labs/LabAgentRenameDialog.tsx",
      "apps/web/src/components/labs/LabExpertBootstrap.tsx",
      "apps/web/src/components/training/ModelUseDialog.tsx",
    ];
    const sources = await Promise.all(paths.map((path) => readFile(path, "utf8")));

    for (const source of sources) {
      expect(source).toContain('from "../dialogs/AppDialog"');
      expect(source).toContain("<AppDialog");
    }
  });
});
