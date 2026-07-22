import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import { waitForRendererCondition } from "./helpers";

export async function clickAriaButton(
  harness: DesktopHarness,
  label: string,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const button = document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)});
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    `${label} button`,
  );
}

export async function clickButton(
  harness: DesktopHarness,
  text: string,
  rootSelector = "body",
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const root = document.querySelector(${JSON.stringify(rootSelector)});
      if (!root) return false;
      const button = [...root.querySelectorAll('button')].find((item) => item.textContent?.trim() === ${JSON.stringify(text)});
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.scrollIntoView({ block: 'center' });
      button.click();
      return true;
    })()`,
    `${text} button`,
  );
}

export async function clickButtonContaining(
  harness: DesktopHarness,
  text: string,
  rootSelector = "body",
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const root = document.querySelector(${JSON.stringify(rootSelector)});
      if (!root) return false;
      const button = [...root.querySelectorAll('button')].find((item) => item.textContent?.includes(${JSON.stringify(text)}));
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.scrollIntoView({ block: 'center' });
      button.click();
      return true;
    })()`,
    `${text} button`,
  );
}

export async function fillControl(
  harness: DesktopHarness,
  selector: string,
  value: string,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(
        input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value',
      );
      descriptor?.set?.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
      return input.value === ${JSON.stringify(value)};
    })()`,
    `${selector} value`,
  );
}

export async function clearTransientFocus(
  harness: DesktopHarness,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      return document.activeElement === document.body;
    })()`,
    "transient form focus cleared",
  );
}

export async function fillComposerPrompt(
  harness: DesktopHarness,
  prompt: string,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const inputs = [...document.querySelectorAll('.composer-inline-input[role="textbox"]')];
      const input = inputs.find((candidate) =>
        candidate instanceof HTMLElement &&
        candidate.offsetParent !== null &&
        candidate.querySelector('[data-inline-token="true"]'))
        ?? inputs.find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null);
      if (!(input instanceof HTMLElement)) return false;
      const token = input.querySelector('[data-inline-token="true"]');
      for (const child of [...input.childNodes]) {
        if (child !== token) child.remove();
      }
      input.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', ${JSON.stringify(prompt)});
      input.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }));
      const form = input.closest('form.composer');
      const send = form?.querySelector('.send-button');
      return (input.textContent ?? '').includes(${JSON.stringify(prompt)}) &&
        send instanceof HTMLButtonElement && !send.disabled;
    })()`,
    "visible composer prompt",
    { timeoutMs: 10_000 },
  );
}

export async function clickTab(
  harness: DesktopHarness,
  text: string,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const button = [...document.querySelectorAll('[role="tab"]')].find((item) => item.textContent?.trim().startsWith(${JSON.stringify(text)}));
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return button.getAttribute('aria-selected') === 'true' || button.classList.contains('active');
    })()`,
    `${text} tab`,
  );
}

export async function clickWorkproduct(
  harness: DesktopHarness,
  name: string,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const row = [...document.querySelectorAll('tbody tr')].find((candidate) =>
        [...candidate.querySelectorAll('*')].some((item) =>
          item.children.length === 0 && item.textContent?.trim() === ${JSON.stringify(name)}));
      if (!(row instanceof HTMLTableRowElement)) return false;
      row.click();
      return true;
    })()`,
    `${name} workproduct`,
  );
}

export async function useWorkproduct(
  harness: DesktopHarness,
  name: string,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const row = [...document.querySelectorAll('tbody tr')].find((candidate) =>
        [...candidate.querySelectorAll('*')].some((item) =>
          item.children.length === 0 && item.textContent?.trim() === ${JSON.stringify(name)}));
      const button = row && [...row.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Use');
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    `Use ${name}`,
  );
  await waitForComposerInvocation(harness, name);
}

export async function selectVisibleChats(
  harness: DesktopHarness,
  dialogSelector: string,
  minimum: number,
): Promise<void> {
  await clickButton(harness, "Select visible", dialogSelector);
  await waitForRendererCondition(
    harness,
    `document.querySelectorAll(${JSON.stringify(`${dialogSelector} input[type='checkbox']:checked`)}).length >= ${minimum}`,
    `${minimum} selected supporting chats`,
  );
}

export async function selectChatsByTitles(
  harness: DesktopHarness,
  dialogSelector: string,
  titles: string[],
): Promise<void> {
  for (const title of titles) {
    await fillControl(
      harness,
      `${dialogSelector} input[placeholder='Search chats']`,
      title,
    );
    await waitForRendererCondition(
      harness,
      `(() => {
        const dialog = document.querySelector(${JSON.stringify(dialogSelector)});
        if (!dialog) return false;
        const label = [...dialog.querySelectorAll('.training-source-options label')].find((candidate) =>
          candidate.querySelector('strong')?.textContent?.trim() === ${JSON.stringify(title)});
        const checkbox = label?.querySelector('input[type="checkbox"]');
        if (!(checkbox instanceof HTMLInputElement)) return false;
        if (!checkbox.checked) checkbox.click();
        return checkbox.checked;
      })()`,
      `${title} supporting chat`,
      { timeoutMs: 30_000 },
    );
  }
  await fillControl(
    harness,
    `${dialogSelector} input[placeholder='Search chats']`,
    "Account Health",
  );
}

export async function selectComposerAction(
  harness: DesktopHarness,
  query: string,
  label: string,
): Promise<void> {
  if (harness.renderer.replaceComposerText) {
    await harness.renderer.replaceComposerText(query);
  } else {
    await harness.renderer.evaluate(`(() => {
    const input = [...document.querySelectorAll('.composer-inline-input[role="textbox"]')]
      .find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null);
    if (!(input instanceof HTMLElement)) return false;
    input.focus();
    input.textContent = ${JSON.stringify(query)};
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(query)} }));
    return true;
    })()`);
  }
  await harness.renderer.assertText(label, { label: `${label} action picker`, timeoutMs: 30_000 });
  await chooseComposerAction(harness, label);
}

export async function chooseComposerAction(
  harness: DesktopHarness,
  label: string,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      const root = document.querySelector('.composer-slash-menu');
      const button = root && [...root.querySelectorAll('button')].find((item) =>
        item.textContent?.includes(${JSON.stringify(label)}));
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    `${label} action option`,
    { timeoutMs: 30_000 },
  );
  await waitForComposerInvocation(harness, label);
}

export async function waitForComposerInvocation(
  harness: DesktopHarness,
  label: string,
): Promise<void> {
  await waitForRendererCondition(
    harness,
    `(() => {
      return [...document.querySelectorAll('.composer-inline-input[role="textbox"]')]
        .filter((input) => input instanceof HTMLElement && input.offsetParent !== null)
        .flatMap((input) => [...input.querySelectorAll('[data-inline-token="true"]')])
        .some((token) => token instanceof HTMLElement && token.textContent?.includes(${JSON.stringify(label)}));
    })()`,
    `${label} composer token`,
    { timeoutMs: 30_000 },
  );
}

export async function resizeHarness(
  harness: DesktopHarness,
  width: number,
  height: number,
): Promise<void> {
  if (harness.renderer.setViewport) {
    await harness.renderer.setViewport(width, height);
  } else {
    await harness.renderer.evaluate(`(() => {
      window.resizeTo(${width}, ${height});
      return true;
    })()`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

export async function screenshot(
  harness: DesktopHarness,
  id: string,
  name: string,
): Promise<void> {
  await harness.screenshot(`${id}-${name}`);
  harness.recordEvent(`${id} ${name}`);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
