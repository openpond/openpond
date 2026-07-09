import type { BootstrapPayload } from "@openpond/contracts";

import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import {
  reloadRenderer,
  waitForRendererCondition,
} from "./helpers";

const DEFAULT_HEARTBEAT_SECONDS = 60;
const UPDATED_HEARTBEAT_SECONDS = 25;

export default desktopScenario({
  name: "subagent-heartbeat-settings",
  mode: "isolated",
  timeoutMs: 90_000,
  async run(harness) {
    await harness.api.fetchJson("/v1/preferences", {
      method: "PATCH",
      body: {
        subagents: {
          enabled: true,
          heartbeatIntervalSeconds: DEFAULT_HEARTBEAT_SECONDS,
        },
      },
    });
    await reloadRenderer(harness);

    await openSubagentsSettings(harness);
    await harness.renderer.assertText("Subagents", { label: "subagents settings title" });
    await harness.renderer.assertText("Background check seconds", { label: "heartbeat setting label" });
    await harness.renderer.assertText(
      "OpenPond checks active child workers at this cadence. It does not wake the parent model every interval.",
      { label: "heartbeat setting help text" },
    );
    await waitForHeartbeatInput(harness, {
      value: String(DEFAULT_HEARTBEAT_SECONDS),
      min: "10",
      max: "3600",
    });
    harness.recordAssertion("defaultHeartbeatVisible", true);
    harness.recordAssertion("heartbeatBoundsVisible", true);
    harness.recordAssertion("heartbeatHelpTextVisible", true);

    await setHeartbeatInput(harness, UPDATED_HEARTBEAT_SECONDS);
    await saveSubagentsSettings(harness);
    const saved = await waitForPersistedHeartbeat(harness, UPDATED_HEARTBEAT_SECONDS);
    harness.recordAssertion("heartbeatPreferencePersisted", true);

    await reloadRenderer(harness);
    await openSubagentsSettings(harness);
    await waitForHeartbeatInput(harness, {
      value: String(UPDATED_HEARTBEAT_SECONDS),
      min: "10",
      max: "3600",
    });
    harness.recordAssertion("heartbeatReloadReadbackVisible", true);
    harness.recordMetadata({
      initialHeartbeatIntervalSeconds: DEFAULT_HEARTBEAT_SECONDS,
      savedHeartbeatIntervalSeconds: saved.preferences.subagents.heartbeatIntervalSeconds,
    });

    await harness.screenshot("subagent-heartbeat-settings-complete");
    await closeSettings(harness);
  },
});

async function openSubagentsSettings(harness: DesktopHarness): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const subagentsNav = Array.from(document.querySelectorAll('.settings-nav-item'))
        .find((button) => button.textContent?.trim() === 'Subagents');
      if (subagentsNav instanceof HTMLButtonElement) {
        subagentsNav.click();
        return true;
      }
      const trigger = document.querySelector('.user-auth-trigger');
      if (!(trigger instanceof HTMLButtonElement)) return false;
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
      return true;
    })()`,
    "settings navigation or account menu",
    { timeoutMs: 10_000 },
  );
  await waitForRendererCondition(
    harness,
    `(() => {
      const subagentsNav = Array.from(document.querySelectorAll('.settings-nav-item'))
        .find((button) => button.textContent?.trim() === 'Subagents');
      if (subagentsNav instanceof HTMLButtonElement) {
        if (!subagentsNav.classList.contains('active')) subagentsNav.click();
        return true;
      }
      const settingsLink = Array.from(document.querySelectorAll('.user-auth-menu-link'))
        .find((link) => link.textContent?.trim() === 'Settings');
      if (!(settingsLink instanceof HTMLAnchorElement)) return false;
      settingsLink.click();
      return false;
    })()`,
    "settings view opened",
    { timeoutMs: 10_000 },
  );
  await waitForRendererCondition(
    harness,
    `(() => {
      const subagentsNav = Array.from(document.querySelectorAll('.settings-nav-item'))
        .find((button) => button.textContent?.trim() === 'Subagents');
      if (!(subagentsNav instanceof HTMLButtonElement)) return false;
      if (!subagentsNav.classList.contains('active')) subagentsNav.click();
      return subagentsNav.classList.contains('active') &&
        Boolean(document.querySelector('.subagents-settings'));
    })()`,
    "Subagents settings section",
    { timeoutMs: 10_000 },
  );
}

async function waitForHeartbeatInput(
  harness: DesktopHarness,
  expected: { value: string; min: string; max: string },
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const input = heartbeatInput();
      return Boolean(input) &&
        input.value === ${JSON.stringify(expected.value)} &&
        input.getAttribute('min') === ${JSON.stringify(expected.min)} &&
        input.getAttribute('max') === ${JSON.stringify(expected.max)};

      function heartbeatInput() {
        const labels = Array.from(document.querySelectorAll('label.settings-select-field'));
        const label = labels.find((candidate) =>
          candidate.textContent?.includes('Background check seconds')
        );
        const input = label?.querySelector('input');
        return input instanceof HTMLInputElement ? input : null;
      }
    })()`,
    `heartbeat input value ${expected.value}`,
    { timeoutMs: 10_000 },
  );
}

async function setHeartbeatInput(harness: DesktopHarness, value: number): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const input = heartbeatInput();
      if (!input) return false;
      const value = ${JSON.stringify(String(value))};
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) return false;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value === value;

      function heartbeatInput() {
        const labels = Array.from(document.querySelectorAll('label.settings-select-field'));
        const label = labels.find((candidate) =>
          candidate.textContent?.includes('Background check seconds')
        );
        const input = label?.querySelector('input');
        return input instanceof HTMLInputElement ? input : null;
      }
    })()`,
    `set heartbeat input to ${value}`,
    { timeoutMs: 10_000 },
  );
}

async function saveSubagentsSettings(harness: DesktopHarness): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.trim() === 'Save agents');
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    "enabled Save agents button",
    { timeoutMs: 10_000 },
  );
}

async function waitForPersistedHeartbeat(
  harness: DesktopHarness,
  expected: number,
): Promise<BootstrapPayload> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const bootstrap = await harness.api.bootstrap<BootstrapPayload>();
    if (bootstrap.preferences.subagents.heartbeatIntervalSeconds === expected) return bootstrap;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for persisted heartbeatIntervalSeconds=${expected}.`);
}

async function closeSettings(harness: DesktopHarness): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const back = document.querySelector('.settings-back');
      if (!(back instanceof HTMLButtonElement)) return false;
      back.click();
      return true;
    })()`,
    "settings back button",
    { timeoutMs: 10_000 },
  );
  await waitForRendererCondition(
    harness,
    `!document.querySelector('.settings-shell')`,
    "settings view closed",
    { timeoutMs: 10_000 },
  );
}
