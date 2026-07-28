import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { GetStartedView } from "../apps/web/src/components/get-started/GetStartedView";

describe("GetStartedView", () => {
  test("renders the existing videos as external links", () => {
    const html = renderToStaticMarkup(createElement(GetStartedView));

    expect(html).toContain("<h1>Videos</h1>");
    expect(html).toContain("What is an OpenPond Agent?");
    expect(html).toContain("How to make an agent");
    expect(html).toContain("Create an Agent");
    expect(html).toContain("Use the Agent");
    expect(html).toContain("Improve the Agent");
    expect(html).toContain("Post-training from first principles");
    expect(html).toContain("10. Technical appendix");
    expect(html.match(/target=\"_blank\"/g)).toHaveLength(16);
    expect(html.match(/rel=\"noreferrer\"/g)).toHaveLength(16);
  });

  test("does not embed players, progress, or conceptual decks", () => {
    const html = renderToStaticMarkup(createElement(GetStartedView));

    expect(html).not.toContain("<video");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("How OpenPond works");
    expect(html).not.toContain("Goal loop");
    expect(html).not.toContain("progress");
  });

  test("does not retain course-player state in the app shell", () => {
    const runtimeView = readFileSync(
      "apps/web/src/app/AppRuntimeView.tsx",
      "utf8",
    );
    const mainPane = readFileSync(
      "apps/web/src/components/app-shell/MainPane.tsx",
      "utf8",
    );

    expect(runtimeView).not.toContain("postTrainingCourse");
    expect(runtimeView).not.toContain("makeAgentTutorial");
    expect(mainPane).not.toContain("PostTrainingLearningPanel");
    expect(mainPane).not.toContain("MakeAgentTutorialLearningPanel");
    expect(mainPane).toContain("<GetStartedView />");
  });
});
