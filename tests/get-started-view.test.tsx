import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GetStartedDeckView } from "../apps/web/src/components/get-started/GetStartedDeck";
import { GetStartedView } from "../apps/web/src/components/get-started/GetStartedView";
import { GetStartedVisual } from "../apps/web/src/components/get-started/get-started-visuals";
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
    expect(html).toContain("Create &amp; edit");
    expect(html).toContain("Local &lt;&gt; Hosted");
    expect(html).toContain("Connect 3rd party apps");
    expect(html).not.toContain("Create loop");
    expect(html).not.toContain("Edit loop");
    expect(html).not.toContain("Dual-source sandbox");
    expect(html).not.toContain("Surfaces");
    expect(html).not.toContain("Learn how goals, source-backed agents, hosted profiles, and connected apps work together.");
    expect(html).not.toContain("How local and hosted goals keep objective, evidence, and completion state visible.");
    expect(html).toContain("Goals are durable objectives");
    expect(html).toContain("Start a goal");
    expect(html).toContain("Create an agent");
    expect(html).toContain("Open Profile");
  });

  test("keeps local-hosted copy explicit about profile and target mounts", () => {
    const deck = GET_STARTED_DECKS.find((item) => item.id === "local-hosted");
    const mountSlide = deck?.slides.find((slide) => slide.id === "local-hosted-mounts");

    expect(deck).toBeDefined();
    expect(mountSlide?.detail).toContain("/openpond/profile");
    expect(mountSlide?.detail).toContain("/workspace");

    const deckHtml = renderToStaticMarkup(createElement(GetStartedDeckView, { deck: deck! }));
    const mountHtml = renderToStaticMarkup(createElement(GetStartedVisual, { accent: "cyan", kind: "dual-source" }));

    expect(deckHtml).toContain("Local profile changes can become hosted");
    expect(mountHtml).toContain("/openpond/profile");
    expect(mountHtml).toContain("/workspace");
  });

  test("keeps local-to-hosted profile handoff separate from publish and catalog exposure", () => {
    const localHostedDeck = GET_STARTED_DECKS.find((item) => item.id === "local-hosted");
    const syncSlide = localHostedDeck?.slides.find((slide) => slide.id === "local-hosted-sync");

    expect(syncSlide?.title).toBe("Local profile changes can become hosted");
    expect(syncSlide?.body).toContain("Local profile state tracks source, checks, and push status");
    expect(syncSlide?.detail).toContain("Push, check, publish, and catalog exposure");
  });

  test("keeps slide accents and right-side diagrams restrained", () => {
    const accents = new Set(GET_STARTED_DECKS.flatMap((deck) => deck.slides.map((slide) => slide.accent)));
    const html = renderToStaticMarkup(createElement(GetStartedVisual, { accent: "cyan", kind: "dual-source" }));

    expect([...accents]).toEqual(["cyan"]);
    expect(html).toContain("get-started-diagram-node");
    expect(html).toContain("/openpond/profile");
    expect(html).not.toContain("<svg");
  });

  test("trims repeated decks into five focused topics", () => {
    expect(GET_STARTED_DECKS.map((deck) => deck.label)).toEqual([
      "Goal loop",
      "Create & edit",
      "Profile & SDK",
      "Local <> Hosted",
      "Connect 3rd party apps",
    ]);
    expect(GET_STARTED_DECKS.flatMap((deck) => deck.slides)).toHaveLength(18);
  });

  test("frames create and edit as first-class goal-loop agents", () => {
    const buildDeck = GET_STARTED_DECKS.find((deck) => deck.id === "build");
    const firstSlide = buildDeck?.slides[0];

    expect(buildDeck?.description).toContain("first-class Create and Edit agents");
    expect(firstSlide?.eyebrow).toBe("First-class agents");
    expect(firstSlide?.title).toBe("Create and Edit extend the goal loop");
    expect(firstSlide?.body).toContain("first-class agents specifically designed");
    expect(firstSlide?.detail).toContain("extend the same goal loop");
  });
});
