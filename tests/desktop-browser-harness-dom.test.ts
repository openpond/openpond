import { afterEach, describe, expect, test } from "vitest";
import {
  parseBrowserSnapshotScriptResult,
  parseBrowserTargetResolutionResult,
  resolveBrowserSnapshotTargetScript,
} from "../apps/desktop/src/desktop-browser-harness-dom";

describe("desktop browser harness DOM actionability", () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { Element?: unknown }).Element;
    delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
    delete (globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement;
  });

  test("returns repair reasons for stale, hidden, disabled, and covered snapshot targets", () => {
    const { body, button, overlay } = installFakeDom();

    expect(resolvePath([1, 0])).toEqual({
      ok: false,
      reason: "Browser target is stale.",
    });

    button.style.visibility = "hidden";
    expect(resolvePath([0, 0])).toEqual({
      ok: false,
      reason: "Browser target is not visible.",
    });

    button.style.visibility = "visible";
    button.disabled = true;
    expect(resolvePath([0, 0])).toEqual({
      ok: false,
      reason: "Browser target is disabled.",
    });

    button.disabled = false;
    body.children.push(overlay);
    overlay.parentElement = body;
    (globalThis.document as FakeDocument).topElement = overlay;
    expect(resolvePath([0, 0])).toEqual({
      ok: false,
      reason: "Browser target is covered by another element.",
    });

    (globalThis.document as FakeDocument).topElement = button;
    expect(resolvePath([0, 0])).toMatchObject({
      ok: true,
      point: { x: 40, y: 30 },
      bounds: { x: 20, y: 15, width: 40, height: 30 },
      tag: "button",
      role: "button",
      name: "Submit",
    });
  });

  test("rejects zero-sized browser snapshots instead of returning false empty proof", () => {
    expect(() =>
      parseBrowserSnapshotScriptResult({
        url: "http://127.0.0.1:17876/",
        title: "OpenPond App",
        viewport: {
          width: 0,
          height: 0,
          scrollX: 0,
          scrollY: 0,
        },
        targets: [],
      }),
    ).toThrow("Browser snapshot viewport is not visible. Open the browser panel and try again.");
  });
});

function resolvePath(domPath: number[]) {
  return parseBrowserTargetResolutionResult((0, eval)(resolveBrowserSnapshotTargetScript(domPath)));
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  disabled = false;
  parentElement: FakeElement | null = null;
  style = {
    display: "block",
    visibility: "visible",
    opacity: "1",
  };

  constructor(
    readonly tagName: string,
    readonly textContent: string,
    private readonly rect: { x: number; y: number; width: number; height: number },
  ) {}

  contains(element: unknown): boolean {
    return element === this || this.children.some((child) => child.contains(element));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect() {
    return this.domRect();
  }

  getClientRects() {
    return [this.domRect()];
  }

  scrollIntoView(): void {}

  private domRect() {
    return {
      x: this.rect.x,
      y: this.rect.y,
      left: this.rect.x,
      top: this.rect.y,
      right: this.rect.x + this.rect.width,
      bottom: this.rect.y + this.rect.height,
      width: this.rect.width,
      height: this.rect.height,
    };
  }
}

class FakeDocument {
  topElement: FakeElement | null = null;

  constructor(readonly documentElement: FakeElement) {}

  elementFromPoint(): FakeElement | null {
    return this.topElement;
  }
}

function installFakeDom() {
  const html = new FakeElement("HTML", "", { x: 0, y: 0, width: 800, height: 600 });
  const body = new FakeElement("BODY", "", { x: 0, y: 0, width: 800, height: 600 });
  const button = new FakeElement("BUTTON", "Submit", { x: 20, y: 15, width: 40, height: 30 });
  const overlay = new FakeElement("DIV", "Overlay", { x: 20, y: 15, width: 40, height: 30 });
  html.children = [body];
  body.parentElement = html;
  body.children = [button];
  button.parentElement = body;

  const document = new FakeDocument(html);
  document.topElement = button;

  (globalThis as { Element: typeof FakeElement }).Element = FakeElement;
  (globalThis as { HTMLElement: typeof FakeElement }).HTMLElement = FakeElement;
  (globalThis as { HTMLButtonElement: typeof FakeElement }).HTMLButtonElement = FakeElement;
  (globalThis as { document: FakeDocument }).document = document;
  (globalThis as { window: Record<string, unknown> }).window = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle: (element: FakeElement) => element.style,
  };

  return { body, button, overlay };
}
