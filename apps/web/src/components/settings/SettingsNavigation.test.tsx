import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsNavigation } from "./SettingsNavigation";

describe("SettingsNavigation", () => {
  it("presents Harness as a compact five-page section", () => {
    const html = renderToStaticMarkup(
      <SettingsNavigation
        onBack={() => undefined}
        onSectionChange={() => undefined}
        section="harness-continuous-review"
      />,
    );

    expect(html).toContain("Harness</div>");
    expect(html).toContain("Overview");
    expect(html).toContain("Refiner");
    expect(html).toContain("Continuous Review");
    expect(html).toContain("Contents");
    expect(html).toContain("Releases");
    expect(html).toContain("settings-nav-item active");
  });

  it("moves unrelated controls out of the Harness group", () => {
    const html = renderToStaticMarkup(
      <SettingsNavigation onBack={() => undefined} onSectionChange={() => undefined} section="skills" />,
    );

    expect(html).toContain("Customization");
    expect(html).toContain("Skills");
    expect(html).toContain("Personalization");
    expect(html).toContain("Agents</div>");
    expect(html).not.toContain("Subagents");
    expect(html).not.toContain(">Context<");
    expect(html).not.toContain(">Training<");
  });
});
