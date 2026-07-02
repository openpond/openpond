import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GetStartedDeckView } from "../apps/web/src/components/get-started/GetStartedDeck";
import { GetStartedView } from "../apps/web/src/components/get-started/GetStartedView";
import { GET_STARTED_DECKS } from "../apps/web/src/components/get-started/get-started-content";

const noop = () => undefined;

describe("GetStartedView", () => {
  test("renders the learning page, tabs, default goal deck, and action rail", () => {
    const html = renderToStaticMarkup(
      createElement(GetStartedView, {
        onCreateAgent: noop,
        onOpenApps: noop,
        onOpenChat: noop,
        onOpenCloud: noop,
        onOpenProfile: noop,
      }),
    );

    expect(html).toContain("Goal loop");
    expect(html).toContain("Create loop");
    expect(html).toContain("Dual-source sandbox");
    expect(html).not.toContain("Learn how goals, source-backed agents, hosted profiles, and connected apps work together.");
    expect(html).not.toContain("How local and hosted goals keep objective, evidence, and completion state visible.");
    expect(html).toContain("Goals are durable objectives");
    expect(html).toContain("Start a goal");
    expect(html).toContain("Create an agent");
    expect(html).toContain("Open Profile");
  });

  test("keeps dual-source sandbox copy explicit about profile and target mounts", () => {
    const deck = GET_STARTED_DECKS.find((item) => item.id === "dual-source");

    expect(deck).toBeDefined();
    expect(deck?.slides[0]?.detail).toContain("/openpond/profile");
    expect(deck?.slides[0]?.detail).toContain("/workspace");

    const html = renderToStaticMarkup(createElement(GetStartedDeckView, { deck: deck! }));

    expect(html).toContain("Hosted work can mount two sources");
    expect(html).toContain("/openpond/profile");
    expect(html).toContain("/workspace");
  });

  test("keeps local-to-hosted profile handoff separate from publish and catalog exposure", () => {
    const profileDeck = GET_STARTED_DECKS.find((item) => item.id === "profile");
    const syncSlide = profileDeck?.slides.find((slide) => slide.id === "profile-sync");

    expect(syncSlide?.title).toBe("Local profile changes can become hosted");
    expect(syncSlide?.body).toContain("Local profile state tracks source, checks, and push status");
    expect(syncSlide?.detail).toContain("Push, check, publish, and catalog exposure");
  });
});
