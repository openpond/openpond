import { createElement } from "react";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DatasetSourcePickerDialog } from "../apps/web/src/components/datasets/DatasetSourcePickerDialog";

describe("Dataset source picker", () => {
  test("offers the wired Build and Hugging Face paths without a dead upload route", () => {
    const markup = renderToStaticMarkup(
      createElement(DatasetSourcePickerDialog, {
        onClose: () => undefined,
        onSelect: () => undefined,
      }),
    );

    expect(markup).toContain("Build");
    expect(markup).toContain("Hugging Face");
    expect(markup).toContain("Upload file");
    expect(markup).toContain("Coming next");
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain('<button class="training-button" disabled="" type="button">Continue</button>');
    expect(markup).toContain(
      'aria-describedby="upload-availability" aria-checked="false" disabled=""',
    );
  });

  test("uses Create for Build and keeps URL import behind Continue", async () => {
    const source = await readFile(
      "apps/web/src/components/datasets/DatasetSourcePickerDialog.tsx",
      "utf8",
    );
    expect(source).toContain('selectedSource === "build" ? "Create" : "Continue"');
    expect(source).toContain("if (selected) onSelect(selected.id)");
  });
});
