import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import { clickAriaButton, clickButton, resizeHarness, screenshot } from "./account-agent-ui-helpers";
import { reloadRenderer, waitForRendererCondition } from "./helpers";

export default desktopScenario({
  name: "get-started-make-agent-tutorial",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    await reloadRenderer(harness);
    await resizeHarness(harness, 1920, 1080);
    await clickButton(harness, "Get started", ".sidebar-nav");
    await harness.renderer.assertText("Start here", { label: "Start here section" });
    await harness.renderer.assertText("What is an OpenPond Agent?", { label: "Agent overview" });
    await harness.renderer.assertText("Walkthroughs", { label: "Walkthroughs section" });
    await harness.renderer.assertText("Agents", { label: "Agents walkthrough playlist" });
    await harness.renderer.assertText("3 lessons", { label: "Make Agent lesson count" });
    await waitForRendererCondition(
      harness,
      `(() => {
        const posters = [...document.querySelectorAll('img[src*="how-to-make-an-agent-"][src*="-poster.png"], img[src*="what-is-an-openpond-agent-poster.png"]')];
        return posters.length >= 4 && posters.every((poster) =>
          poster instanceof HTMLImageElement && poster.complete && poster.naturalWidth === 1920 && poster.naturalHeight === 1080
        );
      })()`,
      "Make Agent playlist posters",
      { timeoutMs: 30_000 },
    );
    await screenshot(harness, "T01", "get-started-make-agent-playlist-wide");

    await clickAriaButton(harness, "Play What is an OpenPond Agent?");
    await waitForTutorialMetadata(harness, "What is an OpenPond Agent?", 70, 80);
    await seekTutorial(harness, "What is an OpenPond Agent?", 31);
    await screenshot(harness, "T02", "get-started-agent-overview");
    const overviewMedia = await tutorialMetadata(harness, "What is an OpenPond Agent?");
    await clickAriaButton(harness, "Close video player");

    await clickAriaButton(harness, "Open Agents playlist");
    await waitForTutorialMetadata(harness, "Create an Agent", 95, 105);
    await harness.renderer.assertText("Lessons", { label: "walkthrough Lessons sidebar" });
    await harness.renderer.assertText("Script", { label: "walkthrough Script sidebar" });
    await harness.renderer.assertText("Create an Agent", { label: "Create lesson" });
    await harness.renderer.assertText("Use the Agent", { label: "Use lesson" });
    await harness.renderer.assertText("Improve the Agent", { label: "Improve lesson" });
    await harness.renderer.assertText("Full video", { label: "full Agent walkthrough footer" });
    const hasInternalStepIds = await harness.renderer.evaluate<boolean>(
      `document.querySelector('[aria-label="Agents walkthrough panel"]')?.textContent?.includes('C01') ?? false`,
    );
    if (hasInternalStepIds) throw new Error("Walkthrough sidebar exposes internal frame IDs.");
    await clickAriaButton(harness, "Play full video: How to make an agent");
    await waitForTutorialMetadata(harness, "How to make an agent", 260, 280);
    await seekTutorial(harness, "How to make an agent", 50);
    const fullVideoMedia = await tutorialMetadata(harness, "How to make an agent");
    await screenshot(harness, "T03", "get-started-make-agent-play-all");

    await clickAriaButton(harness, "Play lesson 1: Create an Agent");
    await waitForTutorialMetadata(harness, "Create an Agent", 95, 105);
    await screenshot(harness, "T04", "get-started-make-agent-create");

    await clickAriaButton(harness, "Play lesson 2: Use the Agent");
    await waitForTutorialMetadata(harness, "Use the Agent", 70, 80);
    await screenshot(harness, "T05", "get-started-make-agent-use");

    await clickAriaButton(harness, "Play lesson 3: Improve the Agent");
    await waitForTutorialMetadata(harness, "Improve the Agent", 100, 115);
    await screenshot(harness, "T06", "get-started-make-agent-improve");

    await clickButton(harness, "Script", '[aria-label="Agents walkthrough panel"]');
    await harness.renderer.assertText("Compare the results", { label: "Improve lesson script" });
    await screenshot(harness, "T07", "get-started-make-agent-improve-script");

    await clickAriaButton(harness, "Close video player");
    await resizeHarness(harness, 620, 900);
    await waitForRendererCondition(
      harness,
      `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
      "narrow Get Started page without horizontal overflow",
    );
    await clickAriaButton(harness, "Open Agents playlist");
    await waitForTutorialMetadata(harness, "Create an Agent", 95, 105);
    await screenshot(harness, "T08", "get-started-make-agent-playlist-narrow");

    const media = await tutorialMetadata(harness, "Create an Agent");
    harness.recordAssertion("tutorialPlaylistPostersLoaded", true);
    harness.recordAssertion("agentOverviewPlaybackMetadataLoaded", true);
    harness.recordAssertion("tutorialPlaybackMetadataLoaded", true);
    harness.recordAssertion("tutorialCaptionsAvailable", media.captions === 1);
    harness.recordAssertion("tutorialSidebarUsesUserFacingLessons", !hasInternalStepIds);
    harness.recordAssertion("tutorialCreateUseImproveVideosLoaded", true);
    harness.recordAssertion("tutorialNarrowLayoutHasNoOverflow", true);
    harness.recordMetadata({ fullVideoMedia, media, overviewMedia, screenshots: 8 });
  },
});

async function waitForTutorialMetadata(
  harness: DesktopHarness,
  title: string,
  minimumDuration: number,
  maximumDuration = Number.POSITIVE_INFINITY,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const video = document.querySelector('[aria-label="${title} player"] video');
      return video instanceof HTMLVideoElement &&
        Number.isFinite(video.duration) && video.duration >= ${minimumDuration} && video.duration <= ${maximumDuration} &&
        video.videoWidth === 1920 && video.videoHeight === 1080 &&
        video.textTracks.length === 1;
    })()`,
    `1920x1080 captioned ${title} metadata`,
    { timeoutMs: 30_000 },
  );
}

async function tutorialMetadata(
  harness: DesktopHarness,
  title: string,
): Promise<{ captions: number; duration: number; height: number; width: number }> {
  return harness.renderer.evaluate(`(() => {
    const video = document.querySelector('[aria-label="${title} player"] video');
    if (!(video instanceof HTMLVideoElement)) throw new Error('Tutorial video is missing.');
    return {
      captions: video.textTracks.length,
      duration: video.duration,
      height: video.videoHeight,
      width: video.videoWidth,
    };
  })()`);
}

async function seekTutorial(
  harness: DesktopHarness,
  title: string,
  seconds: number,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const video = document.querySelector('[aria-label="${title} player"] video');
      if (!(video instanceof HTMLVideoElement) || !Number.isFinite(video.duration)) return false;
      const target = Math.min(${seconds}, Math.max(0, video.duration - 0.5));
      if (Math.abs(video.currentTime - target) > 0.2) video.currentTime = target;
      video.pause();
      return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && Math.abs(video.currentTime - target) <= 0.2;
    })()`,
    `tutorial seek to ${seconds}s`,
    { timeoutMs: 30_000 },
  );
}
