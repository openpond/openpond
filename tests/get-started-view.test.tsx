import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GetStartedDeckView } from "../apps/web/src/components/get-started/GetStartedDeck";
import { GetStartedView } from "../apps/web/src/components/get-started/GetStartedView";
import { GetStartedVisual } from "../apps/web/src/components/get-started/get-started-visuals";
import { GET_STARTED_DECKS } from "../apps/web/src/components/get-started/get-started-content";

const noop = () => undefined;

describe("GetStartedView", () => {
  test("renders the learning page, tabs, and default goal deck without the action rail", () => {
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
    expect(html).toContain("Orchestration");
    expect(html).toContain("Create/Edit Loop");
    expect(html).toContain("Insights Loop");
    expect(html).toContain("Profile");
    expect(html).toContain("Local &lt;&gt; Hosted");
    expect(html).toContain("Connect 3rd party apps");
    expect(html).not.toContain("Profile &amp; SDK");
    expect(html).not.toContain("Create &amp; edit");
    expect(html).not.toContain("Insights loop");
    expect(html).not.toContain("Create loop");
    expect(html).not.toContain("Edit loop");
    expect(html).not.toContain("Dual-source sandbox");
    expect(html).not.toContain("Surfaces");
    expect(html).not.toContain("Learn how goals, source-backed agents, hosted profiles, and connected apps work together.");
    expect(html).not.toContain("How local and hosted goals keep objective, evidence, and completion state visible.");
    expect(html).toContain("Goals are durable objectives");
    expect(html).not.toContain("Related actions");
    expect(html).not.toContain("Start a goal");
    expect(html).not.toContain("Create an agent");
    expect(html).not.toContain("Open Cloud");
  });

  test("keeps local-hosted copy explicit about profile and target mounts", () => {
    const deck = GET_STARTED_DECKS.find((item) => item.id === "local-hosted");
    const mountSlide = deck?.slides.find((slide) => slide.id === "local-hosted-mounts");

    expect(deck).toBeDefined();
    expect(mountSlide?.detail).toContain("/openpond/profile");
    expect(mountSlide?.detail).toContain("/workspace");

    const deckHtml = renderToStaticMarkup(createElement(GetStartedDeckView, { deck: deck! }));
    const mountHtml = renderToStaticMarkup(createElement(GetStartedVisual, { accent: "cyan", kind: "dual-source" }));

    expect(deckHtml).toContain("Hosted work keeps sources separate");
    expect(mountHtml).toContain("/openpond/profile");
    expect(mountHtml).toContain("/workspace");
  });

  test("keeps local-hosted publish copy focused on reviewed snapshots", () => {
    const localHostedDeck = GET_STARTED_DECKS.find((item) => item.id === "local-hosted");
    const publishSlide = localHostedDeck?.slides.find((slide) => slide.id === "local-hosted-publish");

    expect(publishSlide?.title).toBe("Published snapshots avoid source drift");
    expect(publishSlide?.body).toContain("checked manifest snapshot");
    expect(publishSlide?.detail).toContain("reviewed snapshot");
  });

  test("keeps slide accents and right-side diagrams restrained", () => {
    const accents = new Set(GET_STARTED_DECKS.flatMap((deck) => deck.slides.map((slide) => slide.accent)));
    const html = renderToStaticMarkup(createElement(GetStartedVisual, { accent: "cyan", kind: "dual-source" }));

    expect([...accents]).toEqual(["cyan"]);
    expect(html).toContain("get-started-diagram-node");
    expect(html).toContain("/openpond/profile");
    expect(html).not.toContain("<svg");
  });

  test("trims repeated decks into seven focused topics", () => {
    expect(GET_STARTED_DECKS.map((deck) => deck.label)).toEqual([
      "Goal loop",
      "Orchestration",
      "Create/Edit Loop",
      "Insights Loop",
      "Profile",
      "Local <> Hosted",
      "Connect 3rd party apps",
    ]);
    expect(GET_STARTED_DECKS.flatMap((deck) => deck.slides)).toHaveLength(14);
  });

  test("frames create and edit as first-class goal-loop agents", () => {
    const buildDeck = GET_STARTED_DECKS.find((deck) => deck.id === "build");
    const firstSlide = buildDeck?.slides[0];

    expect(buildDeck?.description).toContain("specific implementations on top of goals");
    expect(firstSlide?.eyebrow).toBe("First-class agents");
    expect(firstSlide?.title).toBe("Create/Edit is built on goals");
    expect(firstSlide?.body).toContain("implementations on top of the goal loop");
    expect(firstSlide?.detail).toContain("source-aware planning");
  });

  test("adds an insights loop deck based on create/edit pipeline state", () => {
    const insightsDeck = GET_STARTED_DECKS.find((deck) => deck.id === "insights");
    const detectorSlide = insightsDeck?.slides[0];
    const actionSlide = insightsDeck?.slides[1];

    expect(insightsDeck?.label).toBe("Insights Loop");
    expect(detectorSlide?.title).toBe("Insights runs on top of goals");
    expect(detectorSlide?.body).toContain("specific implementation on top of goals");
    expect(detectorSlide?.body).toContain("create_pipeline.updated");
    expect(detectorSlide?.detail).toContain("Awaiting questions");
    expect(actionSlide?.body).toContain("Lab → Signals");
    expect(actionSlide?.detail).toContain("insight_items");
  });

  test("renames profile deck and focuses it on a portable Git-backed repository", () => {
    const profileDeck = GET_STARTED_DECKS.find((deck) => deck.id === "profile");

    expect(profileDeck?.label).toBe("Profile");
    expect(profileDeck?.slides).toHaveLength(2);
    expect(profileDeck?.slides[0]?.title).toBe("One agent repository travels with you");
    expect(profileDeck?.slides[0]?.detail).toContain("Git-backed");
    expect(profileDeck?.slides[1]?.title).toBe("Artifacts make agents portable");
  });

  test("uses real connected app icons and keeps app slides title-led", () => {
    const connectDeck = GET_STARTED_DECKS.find((deck) => deck.id === "connect-apps");
    const appsSlide = connectDeck?.slides.find((slide) => slide.id === "connect-apps-grid");
    const channelSlide = connectDeck?.slides.find((slide) => slide.id === "connect-channels");
    const appsVisualHtml = renderToStaticMarkup(createElement(GetStartedVisual, { accent: "cyan", kind: "apps-grid" }));
    const channelVisualHtml = renderToStaticMarkup(createElement(GetStartedVisual, { accent: "cyan", kind: "channel-router" }));

    expect(appsSlide?.body).toBeUndefined();
    expect(appsSlide?.detail).toBeUndefined();
    expect(channelSlide?.body).toBeUndefined();
    expect(channelSlide?.detail).toBeUndefined();
    expect(appsVisualHtml).toContain("./connected-apps/github.svg");
    expect(appsVisualHtml).toContain("./connected-apps/slack.svg");
    expect(appsVisualHtml).toContain("./connected-apps/microsoft.svg");
    expect(appsVisualHtml).toContain("./connected-apps/openpond-mcp.svg");
    expect(channelVisualHtml).toContain("./openpond-icon.png");
    expect(channelVisualHtml).toContain("Microsoft Teams");
  });
});
