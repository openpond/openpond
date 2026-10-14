import { z } from "zod";

export const BrowserCaptureModeSchema = z.enum(["page", "node"]);
export type BrowserCaptureMode = z.infer<typeof BrowserCaptureModeSchema>;
export const BrowserCaptureRectSchema = z.object({
  x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(),
  width: z.number().finite().positive().max(16_000), height: z.number().finite().positive().max(16_000),
}).refine(rect => rect.width * rect.height <= 40_000_000, "The snapshot is too large.");
export const BrowserDomCaptureSchema = z.object({
  rect: BrowserCaptureRectSchema, selector: z.string().max(500),
  html: z.string().max(6 * 1024 * 1024).optional(),
  source: z.string().max(64_000).optional(),
});
export type BrowserDomCapture = z.infer<typeof BrowserDomCaptureSchema>;
export type BrowserImageCapture = { dataUrl: string; width: number; height: number; selector: string; source?: string };
export type BrowserCaptureResult = { ok: true; image: BrowserImageCapture } | { ok: false; error: string; canceled?: boolean };

// This function is serialized into both the isolated HTML bootstrap and native
// browser pages. Keep it self-contained; page code never receives host APIs.
function createInspector(deliver: (result: { capture?: BrowserDomCapture; canceled?: boolean; error?: string }) => void, serialize: boolean) {
  let active = false;
  let selected: Element | null = null;
  let overlay: HTMLDivElement | null = null;
  function selector(element: Element) {
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${[...element.classList].slice(0, 3).map(name => `.${name}`).join("")}`.slice(0, 500);
  }
  function markup(element: Element, width: number, height: number) {
    let svg = element instanceof SVGElement && element.tagName.toLowerCase() !== "svg" ? element.ownerSVGElement : null;
    while (svg?.ownerSVGElement) svg = svg.ownerSVGElement;
    const root = svg ?? element;
    let clone = root.cloneNode(true) as HTMLElement;
    const originals = [root, ...root.querySelectorAll("*")];
    const copies = [clone, ...clone.querySelectorAll("*")];
    for (let i = 0; i < originals.length; i++) {
      const original = originals[i]!;
      const copy = copies[i] as HTMLElement | SVGElement;
      if (["SCRIPT", "IFRAME", "OBJECT", "EMBED", "LINK", "META"].includes(copy.tagName)) { copy.remove(); continue; }
      const attributes = [...copy.attributes];
      for (const attribute of attributes) if (/^on/i.test(attribute.name)) copy.removeAttribute(attribute.name);
      if (copy instanceof HTMLElement || copy instanceof SVGElement) {
        const style = getComputedStyle(original);
        copy.style.cssText = [...style].map(name => {
          const value = style.getPropertyValue(name).replace(/url\((["']?)(.*?)\1\)/g, (match, _quote, url: string) => {
            const hash = url.indexOf("#");
            return hash > 0 && [document.baseURI.split("#")[0], document.URL.split("#")[0]].includes(url.slice(0, hash)) ? `url("#${url.slice(hash + 1)}")` : match;
          });
          return `${name}:${value};`;
        }).join("");
        copy.style.setProperty("animation", "none");
        copy.style.setProperty("transition", "none");
      }
      if (original instanceof HTMLInputElement) {
        copy.setAttribute("value", original.value);
        if (original.checked) copy.setAttribute("checked", ""); else copy.removeAttribute("checked");
      }
      if (original instanceof HTMLTextAreaElement) copy.textContent = original.value;
      if (original instanceof HTMLOptionElement) {
        if (original.selected) copy.setAttribute("selected", ""); else copy.removeAttribute("selected");
      }
      if (original instanceof HTMLCanvasElement) {
        const image = document.createElement("img");
        image.src = original.toDataURL("image/png"); image.style.cssText = copy.style.cssText;
        if (original === root) clone = image; else copy.replaceWith(image);
      }
      if (original.shadowRoot) throw new Error("This element has a shadow root. Capture it from a native browser tab.");
    }
    clone.style.setProperty("margin", "0"); clone.style.setProperty("position", "relative");
    clone.style.setProperty("inset", "auto"); clone.style.setProperty("width", `${width}px`);
    clone.style.setProperty("max-width", "none");
    const wrapper = document.createElement("div");
    wrapper.style.width = `${width}px`; wrapper.style.height = `${height}px`;
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const color = getComputedStyle(ancestor).backgroundColor;
      if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") { wrapper.style.backgroundColor = color; break; }
    }
    if (svg) {
      // SVG descendants need their viewBox, definitions and ancestor transforms.
      // Render the original SVG context and crop it to the selected node's box.
      const rootBounds = svg.getBoundingClientRect(), bounds = element.getBoundingClientRect();
      Object.assign(wrapper.style, { position: "relative", overflow: "hidden", width: `${width}px`, height: `${Math.ceil(bounds.height)}px` });
      Object.assign(clone.style, { position: "absolute", left: `${rootBounds.left - bounds.left}px`, top: `${rootBounds.top - bounds.top}px`, width: `${rootBounds.width}px`, height: `${rootBounds.height}px` });
    }
    wrapper.append(clone);
    return wrapper.outerHTML;
  }
  function capture(element: Element, full: boolean) {
    try {
      const bounds = element.getBoundingClientRect();
      const width = full ? Math.max(document.documentElement.clientWidth, document.documentElement.scrollWidth) : Math.ceil(bounds.width);
      const height = full ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) : Math.ceil(bounds.height);
      if (!width || !height) throw new Error("The selected element has no visible area.");
      deliver({ capture: {
        rect: { x: full ? 0 : Math.max(0, bounds.left + scrollX), y: full ? 0 : Math.max(0, bounds.top + scrollY), width, height },
        selector: full ? "Full page" : selector(element),
        source: element.outerHTML.slice(0, 64_000),
        ...(serialize ? { html: markup(element, width, height) } : {}),
      } });
    } catch (error) { deliver({ error: error instanceof Error ? error.message : String(error) }); }
  }
  function stop() {
    active = false; selected = null; overlay?.remove(); overlay = null;
    document.removeEventListener("pointermove", hover, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("keydown", key, true);
    window.removeEventListener("click", click, true);
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup"]) window.removeEventListener(type, suppress, true);
  }
  function hover(event: PointerEvent) {
    if (!active) return;
    selected = event.composedPath().find(item => item instanceof Element && item !== overlay) as Element ?? null;
    if (!selected || !overlay) return;
    const bounds = selected.getBoundingClientRect();
    Object.assign(overlay.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
    overlay.textContent = `${selector(selected)} · ${Math.ceil(bounds.width)} × ${Math.ceil(bounds.height)}`;
  }
  function click(event: MouseEvent) {
    if (!active || !event.isTrusted) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const element = event.composedPath().find(item => item instanceof Element && item !== overlay) as Element;
    stop(); if (element) capture(element, false);
  }
  function suppress(event: Event) { if (active) { event.preventDefault(); event.stopImmediatePropagation(); } }
  function key(event: KeyboardEvent) {
    if (event.key !== "Escape" || !event.isTrusted) return;
    event.preventDefault(); event.stopImmediatePropagation(); stop(); deliver({ canceled: true });
  }
  return {
    page() { stop(); capture(document.body, true); },
    start() {
      stop(); active = true; overlay = document.createElement("div");
      overlay.setAttribute("data-openpond-snapshot-overlay", "");
      overlay.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid var(--blue,Highlight);background:transparent;color:var(--text,CanvasText);font:12px/1.3 monospace;text-shadow:0 0 3px var(--bg,Canvas);overflow:visible;";
      document.documentElement.append(overlay);
      document.addEventListener("pointermove", hover, true);
      window.addEventListener("click", click, true);
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup"]) window.addEventListener(type, suppress, true);
      document.addEventListener("keydown", key, true);
    },
    cancel() { stop(); deliver({ canceled: true }); },
    dispose: stop,
  };
}

export function browserSnapshotInspectorSource() { return `(${createInspector.toString()})`; }
