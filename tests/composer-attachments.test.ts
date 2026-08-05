import { describe, expect, test } from "vitest";
import {
  COMPOSER_PASTED_TEXT_MIN_CHARS,
  createComposerPastedTextFile,
} from "../apps/web/src/components/chat/ComposerAttachments";

describe("composer pasted text attachments", () => {
  test("keeps shorter pasted text inline", () => {
    expect(
      createComposerPastedTextFile(
        "a".repeat(COMPOSER_PASTED_TEXT_MIN_CHARS - 1),
        [],
      ),
    ).toBeNull();
  });

  test("creates a model-readable text attachment for large pastes", async () => {
    const text = "a".repeat(COMPOSER_PASTED_TEXT_MIN_CHARS);
    const file = createComposerPastedTextFile(text, []);

    expect(file).not.toBeNull();
    expect(file?.name).toBe("Pasted text.txt");
    expect(file?.type).toBe("text/plain");
    expect(await file?.text()).toBe(text);
  });

  test("numbers additional pasted text attachments", () => {
    const file = createComposerPastedTextFile(
      "a".repeat(COMPOSER_PASTED_TEXT_MIN_CHARS),
      [{ name: "Pasted text.txt" }, { name: "notes.txt" }],
    );

    expect(file?.name).toBe("Pasted text 2.txt");
  });

  test("reuses an available pasted text number without duplicating a name", () => {
    const file = createComposerPastedTextFile(
      "a".repeat(COMPOSER_PASTED_TEXT_MIN_CHARS),
      [{ name: "Pasted text 2.txt" }],
    );

    expect(file?.name).toBe("Pasted text.txt");
  });
});
