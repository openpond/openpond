import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import { GetStartedDeckView } from "../apps/web/src/components/get-started/GetStartedDeck";
import { GetStartedView } from "../apps/web/src/components/get-started/GetStartedView";
import {
  MakeAgentTutorialCard,
  MakeAgentTutorialPlayer,
} from "../apps/web/src/components/get-started/MakeAgentTutorialCard";
import {
  PostTrainingSeries,
  PostTrainingSeriesPlayer,
} from "../apps/web/src/components/get-started/PostTrainingSeries";
import { PostTrainingLearningPanel } from "../apps/web/src/components/get-started/PostTrainingLearningPanel";
import { MakeAgentTutorialLearningPanel } from "../apps/web/src/components/get-started/MakeAgentTutorialLearningPanel";
import {
  nextPostTrainingLessonIndex,
  POST_TRAINING_FULL_COURSE,
  POST_TRAINING_LESSONS,
} from "../apps/web/src/components/get-started/post-training-lessons";
import {
  normalizePostTrainingProgress,
  parsePostTrainingProgress,
  postTrainingProgressPercent,
  postTrainingResumeTime,
  startingPostTrainingLessonIndex,
} from "../apps/web/src/components/get-started/post-training-progress";
import { GetStartedVisual } from "../apps/web/src/components/get-started/get-started-visuals";
import { GET_STARTED_DECKS } from "../apps/web/src/components/get-started/get-started-content";
import {
  MAKE_AGENT_TUTORIAL_LESSONS,
  MAKE_AGENT_TUTORIAL_VIDEOS,
  makeAgentTutorialScript,
} from "../apps/web/src/components/get-started/make-agent-tutorial";
import { OPENPOND_AGENT_OVERVIEW } from "../apps/web/src/components/get-started/openpond-agent-overview";

const noop = () => undefined;
const getStartedProps = {
  makeAgentTutorial: null,
  onCreateAgent: noop,
  onCloseMakeAgentTutorial: noop,
  onClosePostTrainingCourse: noop,
  onOpenApps: noop,
  onOpenChat: noop,
  onOpenCloud: noop,
  onOpenMakeAgentTutorial: noop,
  onOpenPostTrainingCourse: noop,
  onOpenProfile: noop,
  onSelectMakeAgentTutorialVideo: noop,
  onSelectPostTrainingLesson: noop,
  postTrainingCourse: null,
};
const postTrainingSeriesProps = {
  activeLessonIndex: 0,
  autoplay: true,
  open: false,
  onClose: noop,
  onOpen: noop,
  onSelectLesson: noop,
  playRequestId: 0,
};

describe("GetStartedView", () => {
  test("orders the Agent overview, walkthroughs, deeper learning, and guides", () => {
    const seriesHtml = renderToStaticMarkup(
      createElement(PostTrainingSeries, postTrainingSeriesProps),
    );

    expect(seriesHtml).toContain("Post-training from first principles");
    expect(seriesHtml).toContain("Draft");
    expect(seriesHtml).toContain(
      'data-tooltip="Subject to change, lesson work in progress"',
    );
    expect(seriesHtml).toContain("Learning series");
    expect(seriesHtml).toContain("10 lessons");
    expect(seriesHtml).toContain("29 min");
    expect(seriesHtml).toContain("Open Post-training from first principles playlist");
    expect(seriesHtml).toContain("01-how-post-training-works-poster.webp");
    expect(seriesHtml).toContain("02-definitions-poster.webp");
    expect(seriesHtml).toContain("03-on-policy-off-policy-poster.webp");
    expect(seriesHtml).not.toContain("09-credible-experiments-poster.webp");
    expect(seriesHtml).toContain('aria-haspopup="dialog"');
    expect(seriesHtml).not.toContain("<video");
    expect(seriesHtml).not.toContain("post-training-from-first-principles.mp4");

    const pageHtml = renderToStaticMarkup(
      createElement(GetStartedView, getStartedProps),
    );
    expect(pageHtml.match(/get-started-section-heading/g)).toHaveLength(4);
    expect(pageHtml).toContain('id="get-started-start-here-title">Start here</h2>');
    expect(pageHtml).toContain('id="get-started-walkthroughs-title">Walkthroughs</h2>');
    expect(pageHtml).toContain('id="get-started-learn-title">Learn deeper</h2>');
    expect(pageHtml).toContain(OPENPOND_AGENT_OVERVIEW.title);
    expect(pageHtml).toContain("what-is-an-openpond-agent-poster.png");
    expect(pageHtml).not.toContain("OpenPond guides");
    expect(pageHtml.indexOf(OPENPOND_AGENT_OVERVIEW.title)).toBeLessThan(pageHtml.indexOf("Agents"));
    expect(pageHtml.indexOf("Agents")).toBeLessThan(pageHtml.indexOf("Post-training from first principles"));
    expect(pageHtml.indexOf("Post-training from first principles")).toBeLessThan(pageHtml.indexOf("How OpenPond works"));
  });

  test("keeps the contained player focused on caption-ready video", () => {
    const html = renderToStaticMarkup(
      createElement(PostTrainingSeriesPlayer, { lessonIndex: 5, onClose: noop }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("get-started-course-player-backdrop");
    expect(html).toContain("06-ppo-grpo.mp4");
    expect(html).toContain("06-ppo-grpo.vtt");
    expect(html).not.toContain("Lesson README");
    expect(html).not.toContain("Open script");
    expect(html).toContain("Lesson 6 of 10");
    expect(html).toContain("PPO and GRPO");
    expect(html).toContain('data-auto-advance="true"');
    expect(html).toContain('kind="captions"');
    expect(html).not.toContain("<track default");
    expect(html).not.toContain('aria-modal="true"');
    expect(html).toContain("controls");
    expect(html).not.toContain("autoPlay");
    expect(html).not.toContain("autoplay");
    expect(html).toContain("Close video player");
  });

  test("plays the continuous course without treating it as an eleventh lesson", () => {
    const html = renderToStaticMarkup(
      createElement(PostTrainingSeries, {
        ...postTrainingSeriesProps,
        fullCourseSelected: true,
        open: true,
      }),
    );

    expect(html).toContain("full-course.mp4");
    expect(html).toContain("full-course.vtt");
    expect(html).toContain("Full course · 29:20");
    expect(html).not.toContain("Lesson 1 of 10");
    expect(html).not.toContain('data-auto-advance="true"');
  });

  test("hides the bottom guides deck while either video player is open", () => {
    const playlistHtml = renderToStaticMarkup(
      createElement(GetStartedView, {
        ...getStartedProps,
        postTrainingCourse: {
          autoplay: true,
          fullCourseSelected: false,
          lessonIndex: 0,
          panelView: "lessons" as const,
          playRequestId: 0,
          scriptLessonIndex: null,
        },
      }),
    );
    const tutorialHtml = renderToStaticMarkup(
      createElement(GetStartedView, {
        ...getStartedProps,
        makeAgentTutorial: {
          autoplay: true,
          panelView: "lessons" as const,
          playRequestId: 0,
          videoId: "play-all" as const,
        },
      }),
    );

    for (const html of [playlistHtml, tutorialHtml]) {
      expect(html).toContain("course-player-open");
      expect(html).not.toContain('id="openpond-guides-title"');
      expect(html).not.toContain('aria-label="Get started topics"');
      expect(html).not.toContain("get-started-deck");
    }
  });

  test("opens each lesson's named Markdown script from its right-panel row", () => {
    const lessonsHtml = renderToStaticMarkup(
      createElement(PostTrainingLearningPanel, {
        activeLessonIndex: 5,
        autoplay: true,
        fullCourseSelected: false,
        onOpenScript: noop,
        onResizeStart: noop,
        onSelectFullCourse: noop,
        onSelectLesson: noop,
        onSetAutoplay: noop,
        onShowLessons: noop,
        panelView: "lessons",
        scriptLessonIndex: null,
      }),
    );
    const scriptHtml = renderToStaticMarkup(
      createElement(PostTrainingLearningPanel, {
        activeLessonIndex: 5,
        autoplay: true,
        fullCourseSelected: false,
        onOpenScript: noop,
        onResizeStart: noop,
        onSelectFullCourse: noop,
        onSelectLesson: noop,
        onSetAutoplay: noop,
        onShowLessons: noop,
        panelView: "script",
        scriptLessonIndex: 5,
      }),
    );

    expect(lessonsHtml).toContain("workspace-diff-panel get-started-learning-panel");
    expect(lessonsHtml).toContain("Resize learning panel");
    expect(lessonsHtml).toContain("How post-training works");
    expect(lessonsHtml).toContain("PPO and GRPO");
    expect(lessonsHtml).toContain("Credible experiments");
    expect(lessonsHtml).toContain("Technical appendix");
    expect(lessonsHtml).not.toContain("advances automatically");
    expect(lessonsHtml).toContain("Autoplay");
    expect(lessonsHtml).toContain("Draft");
    expect(lessonsHtml).toContain(
      'data-tooltip="Subject to change, lesson work in progress"',
    );
    expect(lessonsHtml).toContain('role="switch"');
    expect(lessonsHtml).toContain('aria-checked="true"');
    expect(lessonsHtml).not.toContain("10 lessons ·");
    expect(lessonsHtml).toContain("Open script_01.md for How post-training works");
    expect(lessonsHtml).toContain("Open script_09.md for Credible experiments");
    expect(lessonsHtml).toContain("Open script_10.md for Technical appendix");
    expect(lessonsHtml).toContain('data-tooltip="Open script_01.md"');
    expect(lessonsHtml).not.toContain('title="Open script_01.md"');
    expect(lessonsHtml.match(/get-started-learning-lesson-card/g)).toHaveLength(10);
    expect(lessonsHtml).toContain("Full video");
    expect(lessonsHtml).toContain("29:20 · All 10 lessons");
    expect(lessonsHtml).toContain(`Play full video: ${POST_TRAINING_FULL_COURSE.title}`);
    expect(lessonsHtml).toMatch(
      /get-started-learning-lesson-card[\s\S]*Play lesson 1:[\s\S]*Open script_01\.md/,
    );
    expect(lessonsHtml.match(/role="progressbar"/g)).toHaveLength(10);
    expect(lessonsHtml).toContain("How post-training works: 0% watched");
    expect(scriptHtml).toContain("script_06.md");
    expect(scriptHtml).toContain("scripts/script_06.md");
    expect(scriptHtml).toContain("Copy script for an LLM");
    expect(scriptHtml).toContain("Opening Markdown script");
  });

  test("mounts the learning panel in MainPane without replacing workspace panel mode", () => {
    const mainPane = readFileSync(
      new URL("../apps/web/src/components/app-shell/MainPane.tsx", import.meta.url),
      "utf8",
    );
    const runtimeView = readFileSync(
      new URL("../apps/web/src/app/AppRuntimeView.tsx", import.meta.url),
      "utf8",
    );
    const postTrainingSeries = readFileSync(
      new URL("../apps/web/src/components/get-started/PostTrainingSeries.tsx", import.meta.url),
      "utf8",
    );

    expect(mainPane).toContain('view === "get-started" && diffPanelOpen && Boolean(postTrainingCourse)');
    expect(mainPane).toContain('view === "get-started" && diffPanelOpen && Boolean(makeAgentTutorial)');
    expect(mainPane).toContain("makeAgentTutorialPanel ??");
    expect(mainPane).toContain("postTrainingPanel ??");
    expect(mainPane).toContain("<PostTrainingLearningPanel");
    expect(mainPane).toContain("<MakeAgentTutorialLearningPanel");
    expect(mainPane).not.toContain('setRightPanelMode("learning")');
    expect(runtimeView).toContain('(view === "get-started" && Boolean(postTrainingCourse || makeAgentTutorial))');
    expect(runtimeView).toContain("setDiffPanelOpen(true)");
    expect(runtimeView).toContain("playRequestId: 0");
    expect(runtimeView).toContain("playRequestId: current.playRequestId + 1");
    expect(runtimeView).toContain('videoId: "create"');
    expect(runtimeView).toContain('? Boolean(postTrainingCourse || makeAgentTutorial) && diffPanelOpen');
    expect(postTrainingSeries).toContain("if (playRequestId > 0)");
    expect(postTrainingSeries).not.toContain("if (open) void player.play()");
  });

  test("keeps the learning series ordered and individually loadable", () => {
    expect(POST_TRAINING_LESSONS).toHaveLength(10);
    expect(POST_TRAINING_LESSONS.map((lesson) => lesson.lessonNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(POST_TRAINING_LESSONS[0]?.eyebrow).toBe("Start here");
    expect(POST_TRAINING_LESSONS.every((lesson) => lesson.videoUrl.endsWith(".mp4"))).toBe(true);
    expect(POST_TRAINING_LESSONS.every((lesson) => lesson.captionsUrl?.endsWith(".vtt"))).toBe(true);
    expect(POST_TRAINING_LESSONS.map((lesson) => lesson.script?.fileName)).toEqual([
      "script_01.md",
      "script_02.md",
      "script_03.md",
      "script_04.md",
      "script_05.md",
      "script_06.md",
      "script_07.md",
      "script_08.md",
      "script_09.md",
      "script_10.md",
    ]);
    expect(POST_TRAINING_LESSONS.every((lesson) =>
      lesson.script?.url.includes("/scripts/script_") && lesson.script.url.endsWith(".md")
    )).toBe(true);
    expect(POST_TRAINING_LESSONS.map((lesson) => lesson.slug)).toEqual([
      "01-how-post-training-works",
      "02-definitions",
      "03-on-policy-off-policy",
      "04-rewards-credit-assignment",
      "05-verifiable-rewards-rlvr",
      "06-ppo-grpo",
      "07-distillation",
      "08-opsd-sdft-sdpo",
      "09-credible-experiments",
      "10-technical-appendix",
    ]);
    expect(nextPostTrainingLessonIndex(0)).toBe(1);
    expect(nextPostTrainingLessonIndex(6)).toBe(7);
    expect(nextPostTrainingLessonIndex(7)).toBe(8);
    expect(nextPostTrainingLessonIndex(8)).toBe(9);
    expect(nextPostTrainingLessonIndex(9)).toBeNull();
  });

  test("normalizes, reports, resumes, and sequences persistent lesson progress", () => {
    const progress = normalizePostTrainingProgress({
      [POST_TRAINING_LESSONS[0]!.id]: {
        completed: true,
        currentTime: 40,
        duration: 69,
        updatedAt: 10,
      },
      [POST_TRAINING_LESSONS[1]!.id]: {
        completed: false,
        currentTime: 31,
        duration: 62,
        updatedAt: 20,
      },
      invalid: { currentTime: "nope", duration: 0 },
    });

    expect(progress.invalid).toBeUndefined();
    expect(postTrainingProgressPercent(progress[POST_TRAINING_LESSONS[0]!.id])).toBe(100);
    expect(postTrainingProgressPercent(progress[POST_TRAINING_LESSONS[1]!.id])).toBe(50);
    expect(postTrainingResumeTime(progress[POST_TRAINING_LESSONS[1]!.id])).toBe(31);
    expect(postTrainingResumeTime(progress[POST_TRAINING_LESSONS[0]!.id])).toBe(0);
    expect(startingPostTrainingLessonIndex(
      progress,
      POST_TRAINING_LESSONS.map((lesson) => lesson.id),
    )).toBe(1);
    expect(parsePostTrainingProgress("not-json")).toEqual({});
  });

  test("renders the learning page with the Goal loop guide selected by default", () => {
    const html = renderToStaticMarkup(
      createElement(GetStartedView, getStartedProps),
    );

    expect(html).toContain("Agents");
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

  test("puts the Agents playlist and its full video footer in Walkthroughs", () => {
    const walkthroughCardHtml = renderToStaticMarkup(createElement(MakeAgentTutorialCard));
    const walkthroughPlayerHtml = renderToStaticMarkup(
      createElement(MakeAgentTutorialPlayer, { onClose: noop }),
    );
    const pageHtml = renderToStaticMarkup(
      createElement(GetStartedView, getStartedProps),
    );

    expect(walkthroughCardHtml).toContain("Agents");
    expect(walkthroughCardHtml).toContain("Walkthrough playlist");
    expect(walkthroughCardHtml).toContain("3 lessons");
    expect(walkthroughCardHtml).toContain("3:28");
    expect(walkthroughCardHtml).toContain("how-to-make-an-agent-create-poster.png");
    expect(walkthroughCardHtml).toContain("how-to-make-an-agent-use-poster.png");
    expect(walkthroughCardHtml).toContain("how-to-make-an-agent-improve-poster.png");
    expect(walkthroughCardHtml).toContain("Open Agents playlist");
    expect(walkthroughCardHtml).toContain('aria-haspopup="dialog"');
    expect(walkthroughCardHtml).not.toContain("<video");
    expect(walkthroughPlayerHtml).toContain("tutorials/how-to-make-an-agent.mp4");
    expect(walkthroughPlayerHtml).toContain("tutorials/how-to-make-an-agent.vtt");
    expect(walkthroughPlayerHtml).toContain('kind="captions"');
    expect(walkthroughPlayerHtml).toContain("controls");
    expect(walkthroughPlayerHtml).not.toContain("autoplay");
    expect(pageHtml.indexOf("Walkthroughs")).toBeLessThan(
      pageHtml.indexOf("Post-training from first principles"),
    );
    expect(pageHtml).not.toContain("Guided product tours");
    expect(pageHtml.indexOf("Walkthroughs")).toBeLessThan(pageHtml.indexOf("How OpenPond works"));
    expect(MAKE_AGENT_TUTORIAL_LESSONS.map((lesson) => lesson.title)).toEqual([
      "Create an Agent",
      "Use the Agent",
      "Improve the Agent",
    ]);
    expect(MAKE_AGENT_TUTORIAL_VIDEOS.map((video) => video.videoId)).toEqual([
      "play-all",
      "create",
      "use",
      "improve",
    ]);
  });

  test("gives the Make Agent walkthrough the same lessons and script sidebar pattern", () => {
    const lessonsHtml = renderToStaticMarkup(createElement(MakeAgentTutorialLearningPanel, {
      activeVideoId: "play-all",
      autoplay: true,
      onResizeStart: noop,
      onSelectVideo: noop,
      onSetAutoplay: noop,
      onShowLessons: noop,
      onShowScript: noop,
      panelView: "lessons",
    }));
    const scriptHtml = renderToStaticMarkup(createElement(MakeAgentTutorialLearningPanel, {
      activeVideoId: "improve",
      autoplay: true,
      onResizeStart: noop,
      onSelectVideo: noop,
      onSetAutoplay: noop,
      onShowLessons: noop,
      onShowScript: noop,
      panelView: "script",
    }));
    expect(lessonsHtml).toContain("Agents");
    expect(lessonsHtml).toContain("Full video");
    expect(lessonsHtml).toContain("Play full video: How to make an agent");
    expect(lessonsHtml).toContain("3:28 · All 3 lessons");
    expect(lessonsHtml).toContain("Create an Agent");
    expect(lessonsHtml).toContain("Use the Agent");
    expect(lessonsHtml).toContain("Improve the Agent");
    expect(lessonsHtml.match(/get-started-learning-lesson-card/g)).toHaveLength(3);
    expect(lessonsHtml).toContain("Autoplay");
    expect(lessonsHtml).not.toContain("Narrow layout");
    expect(lessonsHtml).not.toContain("C01");
    expect(lessonsHtml).not.toContain("I01");
    expect(scriptHtml).toContain("improve-the-agent.md");
    expect(scriptHtml).toContain("Copy walkthrough script");
    expect(makeAgentTutorialScript("improve")).toContain("Compare the results");
    expect(makeAgentTutorialScript("improve")).not.toContain("Start from a prompt or chats");
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

  test("keeps the seven conceptual guide decks", () => {
    expect(GET_STARTED_DECKS.map((deck) => deck.label)).toEqual([
      "Goal loop",
      "Orchestration",
      "Create/Edit Loop",
      "Insights Loop",
      "Profile",
      "Local <> Hosted",
      "Connect 3rd party apps",
    ]);
    expect(GET_STARTED_DECKS).toHaveLength(7);
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
    expect(detectorSlide?.body).toContain("Create/Improve runs");
    expect(detectorSlide?.body).toContain("create_improve.updated");
    expect(detectorSlide?.detail).toContain("Awaiting questions");
    expect(actionSlide?.body).toContain("suggestions inbox in Lab");
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
