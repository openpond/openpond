import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import { clickAriaButton, clickButton, resizeHarness, screenshot } from "./account-agent-ui-helpers";
import { reloadRenderer, waitForRendererCondition } from "./helpers";

const PLAYER_LABEL = "How to make an agent player";

export default desktopScenario({
  name: "get-started-make-agent-tutorial",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    await reloadRenderer(harness);
    await resizeHarness(harness, 1920, 1080);
    await clickButton(harness, "Get started", ".sidebar-nav");
    await harness.renderer.assertText("Walkthroughs", { label: "Walkthroughs section" });
    await harness.renderer.assertText("How to make an agent", { label: "Make Agent walkthrough card" });
    await waitForRendererCondition(
      harness,
      `(() => {
        const poster = document.querySelector('img[src*="how-to-make-an-agent-poster.png"]');
        return poster instanceof HTMLImageElement && poster.complete && poster.naturalWidth === 1920 && poster.naturalHeight === 1080;
      })()`,
      "Make Agent tutorial poster",
      { timeoutMs: 30_000 },
    );
    await screenshot(harness, "T01", "get-started-make-agent-poster-wide");

    await clickAriaButton(harness, "Play How to make an agent");
    await waitForTutorialMetadata(harness);
    await harness.renderer.assertText("Steps", { label: "walkthrough Steps sidebar" });
    await harness.renderer.assertText("Script", { label: "walkthrough Script sidebar" });
    await harness.renderer.assertText("Review chats before sharing", { label: "walkthrough disclosure step" });
    const hasInternalStepIds = await harness.renderer.evaluate<boolean>(
      `document.querySelector('[aria-label="How to make an agent walkthrough panel"]')?.textContent?.includes('C01') ?? false`,
    );
    if (hasInternalStepIds) throw new Error("Walkthrough sidebar exposes internal frame IDs.");
    await seekTutorial(harness, 50);
    await screenshot(harness, "T02", "get-started-make-agent-playing");

    await clickAriaButton(harness, "Close video player");
    await resizeHarness(harness, 620, 900);
    await waitForRendererCondition(
      harness,
      `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
      "narrow Get Started page without horizontal overflow",
    );
    await clickAriaButton(harness, "Play How to make an agent");
    await waitForTutorialMetadata(harness);
    await screenshot(harness, "T03", "get-started-make-agent-narrow");

    const media = await harness.renderer.evaluate<{
      captions: number;
      duration: number;
      height: number;
      width: number;
    }>(`(() => {
      const video = document.querySelector('[aria-label="${PLAYER_LABEL}"] video');
      if (!(video instanceof HTMLVideoElement)) throw new Error('Tutorial video is missing.');
      return {
        captions: video.textTracks.length,
        duration: video.duration,
        height: video.videoHeight,
        width: video.videoWidth,
      };
    })()`);
    harness.recordAssertion("tutorialPosterLoaded", true);
    harness.recordAssertion("tutorialPlaybackMetadataLoaded", true);
    harness.recordAssertion("tutorialCaptionsAvailable", media.captions === 1);
    harness.recordAssertion("tutorialSidebarUsesUserFacingSteps", !hasInternalStepIds);
    harness.recordAssertion("tutorialNarrowLayoutHasNoOverflow", true);
    harness.recordMetadata({ media, screenshots: 3 });
  },
});

async function waitForTutorialMetadata(harness: DesktopHarness): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const video = document.querySelector('[aria-label="${PLAYER_LABEL}"] video');
      return video instanceof HTMLVideoElement &&
        Number.isFinite(video.duration) && video.duration > 0 &&
        video.videoWidth === 1920 && video.videoHeight === 1080 &&
        video.textTracks.length === 1;
    })()`,
    "1920x1080 captioned tutorial metadata",
    { timeoutMs: 30_000 },
  );
}

async function seekTutorial(
  harness: DesktopHarness,
  seconds: number,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const video = document.querySelector('[aria-label="${PLAYER_LABEL}"] video');
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
