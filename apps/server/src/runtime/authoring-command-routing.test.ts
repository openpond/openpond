import { describe, expect, test } from "vitest";

import { authoringCommandRoute } from "./authoring-command-routing.js";

describe("Refiner authoring command routing", () => {
  test("preloads the bundled Refiner Skill without classifying ordinary prompts", () => {
    expect(authoringCommandRoute("/refiner Treat unreadable requested PDFs as material review evidence.")).toEqual({
      skillName: "openpond-refiner-authoring",
      intent: {
        artifact: "refiner",
        operation: "update",
        objective: "Treat unreadable requested PDFs as material review evidence.",
        source: "slash_command",
      },
    });
    expect(authoringCommandRoute("Treat unreadable requested PDFs as material review evidence.")).toBeNull();
  });
});
