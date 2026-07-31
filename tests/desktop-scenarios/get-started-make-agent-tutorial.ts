import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import {
  clickButton,
  resizeHarness,
  screenshot,
} from "./account-agent-ui-helpers";
import { reloadRenderer, waitForRendererCondition } from "./helpers";

export default desktopScenario({
  name: "get-started-video-links",
  mode: "isolated",
  timeoutMs: 120_000,
  async run(harness) {
    await reloadRenderer(harness);
    await resizeHarness(harness, 1440, 900);
    await clickButton(harness, "Docs", ".sidebar-utility-nav");

    await harness.renderer.assertText("Videos", { label: "Videos heading" });
    await harness.renderer.assertText("What is an OpenPond Agent?", {
      label: "Agent overview link",
    });
    await harness.renderer.assertText("How to make an agent", {
      label: "Agent walkthrough link",
    });
    await harness.renderer.assertText("Post-training from first principles", {
      label: "Post-training section",
    });
    await harness.renderer.assertText("10. Technical appendix", {
      label: "Final post-training lesson",
    });

    const linkCount = await harness.renderer.evaluate<number>(
      `document.querySelectorAll('.get-started-video-link[target="_blank"]').length`,
    );
    if (linkCount !== 16) {
      throw new Error(`Expected 16 Get Started video links, found ${linkCount}.`);
    }
    const embeddedPlayers = await harness.renderer.evaluate<number>(
      `document.querySelectorAll('.get-started-view video, .get-started-view button').length`,
    );
    if (embeddedPlayers !== 0) {
      throw new Error("Get Started should contain links only.");
    }

    await screenshot(harness, "T01", "get-started-video-links-wide");
    await resizeHarness(harness, 620, 900);
    await harness.renderer.evaluate(
      `document.querySelector('button[aria-label="Hide sidebar"]')?.click()`,
    );
    await waitForRendererCondition(
      harness,
      `(() => {
        const shell = document.querySelector('.app-shell');
        const sidebar = document.querySelector('.sidebar');
        return Boolean(
          shell?.classList.contains('sidebar-closed') &&
          sidebar instanceof HTMLElement &&
          sidebar.getBoundingClientRect().right <= 1
        );
      })()`,
      "narrow navigation drawer closed",
    );
    await waitForRendererCondition(
      harness,
      `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
      "narrow Get Started page without horizontal overflow",
    );
    await screenshot(harness, "T02", "get-started-video-links-narrow");

    harness.recordAssertion("videoLinksRendered", true);
    harness.recordAssertion("embeddedPlayersRemoved", true);
    harness.recordAssertion("narrowLayoutHasNoOverflow", true);
    harness.recordMetadata({ linkCount, screenshots: 2 });
  },
});
