import type {
  BrowserHarnessResolvedTarget,
  BrowserHarnessSnapshotData,
  BrowserHarnessSnapshotTarget,
} from "./desktop-browser-harness-types.js";
import type { BrowserBounds } from "./desktop-browser-types.js";

export type BrowserSnapshotScriptTarget = BrowserHarnessSnapshotTarget & {
  domPath: number[];
};

export type BrowserSnapshotScriptResult = Omit<BrowserHarnessSnapshotData, "snapshotId" | "tabId" | "targets"> & {
  targets: BrowserSnapshotScriptTarget[];
};

export type BrowserTargetResolutionResult =
  | {
      ok: true;
      point: { x: number; y: number };
      bounds: BrowserBounds;
      tag: string;
      role: string;
      name: string;
    }
  | {
      ok: false;
      reason: string;
    };

export function collectBrowserSnapshotTargetsScript(maxTargets: number): string {
  return `(${collectBrowserSnapshotTargets.toString()})(${JSON.stringify(maxTargets)})`;
}

export function resolveBrowserSnapshotTargetScript(domPath: number[]): string {
  return `(${resolveBrowserSnapshotTarget.toString()})(${JSON.stringify(domPath)})`;
}

export function updateBrowserCursorOverlayScript(input: {
  x: number;
  y: number;
  click?: boolean;
}): string {
  return `(${updateBrowserCursorOverlay.toString()})(${JSON.stringify(input)})`;
}

export function parseBrowserSnapshotScriptResult(value: unknown): BrowserSnapshotScriptResult {
  const record = asRecord(value);
  if (!record) throw new Error("Browser snapshot result must be an object.");
  const viewport = asRecord(record.viewport);
  if (!viewport) throw new Error("Browser snapshot viewport is missing.");
  const targets = Array.isArray(record.targets)
    ? record.targets.map(parseSnapshotScriptTarget).filter((target): target is BrowserSnapshotScriptTarget => Boolean(target))
    : [];
  return {
    url: stringValue(record.url),
    title: stringValue(record.title),
    viewport: parseBrowserSnapshotViewport(viewport),
    targets,
  };
}

function parseBrowserSnapshotViewport(viewport: Record<string, unknown>): BrowserSnapshotScriptResult["viewport"] {
  const width = numberValue(viewport.width);
  const height = numberValue(viewport.height);
  if (width <= 0 || height <= 0) {
    throw new Error("Browser snapshot viewport is not visible. Open the browser panel and try again.");
  }
  return {
    width,
    height,
    scrollX: numberValue(viewport.scrollX),
    scrollY: numberValue(viewport.scrollY),
  };
}

export function parseBrowserTargetResolutionResult(value: unknown): BrowserTargetResolutionResult {
  const record = asRecord(value);
  if (!record) return { ok: false, reason: "Browser target resolution returned an invalid result." };
  if (record.ok !== true) {
    return {
      ok: false,
      reason: typeof record.reason === "string" && record.reason.trim()
        ? record.reason.trim()
        : "Browser target could not be resolved.",
    };
  }
  const point = asRecord(record.point);
  const bounds = asRecord(record.bounds);
  if (!point || !bounds) return { ok: false, reason: "Browser target resolved without coordinates." };
  return {
    ok: true,
    point: {
      x: numberValue(point.x),
      y: numberValue(point.y),
    },
    bounds: {
      x: numberValue(bounds.x),
      y: numberValue(bounds.y),
      width: numberValue(bounds.width),
      height: numberValue(bounds.height),
    },
    tag: stringValue(record.tag),
    role: stringValue(record.role),
    name: stringValue(record.name),
  };
}

export function snapshotTargetForModel(target: BrowserSnapshotScriptTarget): BrowserHarnessSnapshotTarget {
  const { domPath: _domPath, ...modelTarget } = target;
  return modelTarget;
}

export function resolvedPointFromViewportPoint(input: {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
}): BrowserHarnessResolvedTarget {
  if (input.x < 0 || input.y < 0 || input.x > input.viewportWidth || input.y > input.viewportHeight) {
    throw new Error("Browser point is outside the active viewport.");
  }
  return {
    point: { x: input.x, y: input.y },
    bounds: { x: input.x, y: input.y, width: 1, height: 1 },
  };
}

function collectBrowserSnapshotTargets(maxTargets: number) {
  const selectors = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "label",
    "[role]",
    "[tabindex]:not([tabindex='-1'])",
    "[contenteditable='']",
    "[contenteditable='true']",
    "[onclick]",
    "[aria-label]",
    "[aria-labelledby]",
  ].join(",");
  const elements = Array.from(document.querySelectorAll(selectors));
  const targets = [];
  const seen = new Set();
  for (const element of elements) {
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
    const rect = bestClientRect(element);
    if (!rect || !isVisibleElement(element, rect)) continue;
    const path = domPath(element);
    const pathKey = path.join(".");
    if (!path.length || seen.has(pathKey)) continue;
    seen.add(pathKey);
    const target = snapshotTarget(element, rect, targets.length + 1, path);
    if (!target) continue;
    targets.push(target);
    if (targets.length >= maxTargets) break;
  }
  return {
    url: location.href,
    title: document.title || "",
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    targets,
  };

  function snapshotTarget(element: Element, rect: DOMRect, index: number, path: number[]) {
    const tag = element.tagName.toLowerCase();
    const role = inferredRole(element, tag);
    const name = accessibleName(element);
    const text = compactText(element.textContent || "");
    const value = formValue(element);
    const href = element instanceof HTMLAnchorElement ? element.href : "";
    const disabled = isDisabled(element);
    if (!name && !text && !value && !href && role === "generic") return null;
    return {
      ref: `ref_${index}`,
      role,
      name: name || value || text || href || tag,
      tag,
      bounds: rectRecord(rect),
      domPath: path,
      ...(text ? { text } : {}),
      ...(value ? { value } : {}),
      ...(inputType(element) ? { type: inputType(element) } : {}),
      ...(href ? { href } : {}),
      ...(disabled ? { disabled: true } : {}),
      ...(checkedState(element) !== null ? { checked: checkedState(element) } : {}),
      ...(selectedState(element) !== null ? { selected: selectedState(element) } : {}),
      ...(isEditable(element) ? { editable: true } : {}),
    };
  }

  function bestClientRect(element: Element) {
    const rects = Array.from(element.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? rect : null;
    }
    return rects.sort((left, right) => right.width * right.height - left.width * left.height)[0] || null;
  }

  function isVisibleElement(element: Element, rect: DOMRect) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
    return true;
  }

  function rectRecord(rect: DOMRect) {
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function domPath(element: Element) {
    const path: number[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement) {
      const parent: Element | null = current.parentElement;
      if (!parent) return [];
      path.unshift(Array.prototype.indexOf.call(parent.children, current));
      current = parent;
    }
    return path;
  }

  function inferredRole(element: Element, tag: string) {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.trim().toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "summary") return "button";
    if (isEditable(element)) return "textbox";
    return "generic";
  }

  function accessibleName(element: Element) {
    const aria = element.getAttribute("aria-label");
    if (aria) return compactText(aria);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
      if (label.trim()) return compactText(label);
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      const labels = Array.from(element.labels || []).map((label) => label.textContent || "").join(" ");
      if (labels.trim()) return compactText(labels);
      const placeholder = element.getAttribute("placeholder");
      if (placeholder) return compactText(placeholder);
      const name = element.getAttribute("name");
      if (name) return compactText(name);
    }
    const title = element.getAttribute("title");
    if (title) return compactText(title);
    const alt = element.getAttribute("alt");
    if (alt) return compactText(alt);
    return "";
  }

  function compactText(value: string) {
    return value.replace(/\s+/g, " ").trim().slice(0, 160);
  }

  function formValue(element: Element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return compactText(element.value);
    if (element instanceof HTMLSelectElement) return compactText(element.selectedOptions[0]?.textContent || element.value);
    return "";
  }

  function inputType(element: Element) {
    return element instanceof HTMLInputElement ? (element.type || "text") : "";
  }

  function isEditable(element: Element) {
    return element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      element.getAttribute("contenteditable") === "" ||
      element.getAttribute("contenteditable") === "true";
  }

  function isDisabled(element: Element) {
    if ("disabled" in element && Boolean((element as HTMLButtonElement).disabled)) return true;
    return element.getAttribute("aria-disabled") === "true";
  }

  function checkedState(element: Element) {
    return element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")
      ? element.checked
      : null;
  }

  function selectedState(element: Element) {
    return element instanceof HTMLOptionElement ? element.selected : null;
  }
}

function resolveBrowserSnapshotTarget(domPath: number[]) {
  const element = resolveDomPath(domPath);
  if (!element) return { ok: false, reason: "Browser target is stale." };
  if (isDisabled(element)) return { ok: false, reason: "Browser target is disabled." };
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = bestClientRect(element);
  if (!rect || !isVisibleElement(element, rect)) {
    return { ok: false, reason: "Browser target is not visible." };
  }
  const point = {
    x: Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2)),
    y: Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2)),
  };
  const top = document.elementFromPoint(point.x, point.y);
  if (top && top !== element && !element.contains(top)) {
    return { ok: false, reason: "Browser target is covered by another element." };
  }
  return {
    ok: true,
    point: {
      x: Math.round(point.x),
      y: Math.round(point.y),
    },
    bounds: rectRecord(rect),
    tag: element.tagName.toLowerCase(),
    role: inferredRole(element),
    name: accessibleName(element),
  };

  function resolveDomPath(path: number[]) {
    let current: Element | undefined = document.documentElement;
    for (const index of path) {
      current = current?.children[index];
      if (!current) return null;
    }
    return current;
  }

  function bestClientRect(element: Element) {
    const rects = Array.from(element.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? rect : null;
    }
    return rects.sort((left, right) => right.width * right.height - left.width * left.height)[0] || null;
  }

  function rectRecord(rect: DOMRect) {
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function isVisibleElement(element: Element, rect: DOMRect) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
    return true;
  }

  function isDisabled(element: Element) {
    if ("disabled" in element && Boolean((element as HTMLButtonElement).disabled)) return true;
    return element.getAttribute("aria-disabled") === "true";
  }

  function inferredRole(element: Element) {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.trim().toLowerCase();
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input" || tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    return "generic";
  }

  function accessibleName(element: Element) {
    const aria = element.getAttribute("aria-label");
    if (aria) return aria.replace(/\s+/g, " ").trim().slice(0, 160);
    return (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
  }
}

function updateBrowserCursorOverlay(input: { x: number; y: number; click?: boolean }) {
  const rootId = "__openpond_agent_cursor_root";
  let root = document.getElementById(rootId);
  if (!root) {
    root = document.createElement("div");
    root.id = rootId;
    root.setAttribute("aria-hidden", "true");
    root.style.position = "fixed";
    root.style.left = "0";
    root.style.top = "0";
    root.style.width = "0";
    root.style.height = "0";
    root.style.zIndex = "2147483647";
    root.style.pointerEvents = "none";
    root.style.transition = "transform 160ms cubic-bezier(0.22, 1, 0.36, 1), opacity 120ms ease";
    root.style.opacity = "1";
    root.innerHTML = [
      "<svg width=\"32\" height=\"32\" viewBox=\"0 0 32 32\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\" style=\"filter: drop-shadow(0 0 5px rgba(124, 178, 255, 0.95)) drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45));\">",
      "<path d=\"M6 4L24 15L15.5 17.5L12 26L6 4Z\" fill=\"#F7FAFF\" stroke=\"#111827\" stroke-width=\"2\" stroke-linejoin=\"round\"/>",
      "</svg>",
    ].join("");
    document.documentElement.appendChild(root);
  }
  root.style.transform = `translate(${Math.round(input.x)}px, ${Math.round(input.y)}px)`;
  root.style.opacity = "1";
  const rootWithTimer = root as HTMLElement & { __openpondHideTimer?: number };
  if (rootWithTimer.__openpondHideTimer) window.clearTimeout(rootWithTimer.__openpondHideTimer);
  if (input.click) {
    const pulse = document.createElement("div");
    pulse.style.position = "fixed";
    pulse.style.left = `${Math.round(input.x)}px`;
    pulse.style.top = `${Math.round(input.y)}px`;
    pulse.style.width = "10px";
    pulse.style.height = "10px";
    pulse.style.marginLeft = "-5px";
    pulse.style.marginTop = "-5px";
    pulse.style.border = "2px solid rgba(124, 178, 255, 0.95)";
    pulse.style.borderRadius = "999px";
    pulse.style.zIndex = "2147483646";
    pulse.style.pointerEvents = "none";
    pulse.style.animation = "__openpond_agent_cursor_pulse 420ms ease-out forwards";
    document.documentElement.appendChild(pulse);
    window.setTimeout(() => pulse.remove(), 460);
  }
  if (!document.getElementById("__openpond_agent_cursor_style")) {
    const style = document.createElement("style");
    style.id = "__openpond_agent_cursor_style";
    style.textContent = "@keyframes __openpond_agent_cursor_pulse{0%{transform:scale(1);opacity:.95}100%{transform:scale(4);opacity:0}}";
    document.documentElement.appendChild(style);
  }
  rootWithTimer.__openpondHideTimer = window.setTimeout(() => {
    root.style.opacity = "0";
  }, 2500);
  return true;
}

function parseSnapshotScriptTarget(value: unknown): BrowserSnapshotScriptTarget | null {
  const record = asRecord(value);
  const bounds = asRecord(record?.bounds);
  if (!record || !bounds || !Array.isArray(record.domPath)) return null;
  const ref = stringValue(record.ref);
  if (!ref) return null;
  return {
    ref,
    role: stringValue(record.role),
    name: stringValue(record.name),
    tag: stringValue(record.tag),
    bounds: {
      x: numberValue(bounds.x),
      y: numberValue(bounds.y),
      width: numberValue(bounds.width),
      height: numberValue(bounds.height),
    },
    domPath: record.domPath.filter((item): item is number => Number.isInteger(item) && item >= 0),
    ...(stringValue(record.text) ? { text: stringValue(record.text) } : {}),
    ...(stringValue(record.value) ? { value: stringValue(record.value) } : {}),
    ...(stringValue(record.type) ? { type: stringValue(record.type) } : {}),
    ...(stringValue(record.href) ? { href: stringValue(record.href) } : {}),
    ...(typeof record.disabled === "boolean" ? { disabled: record.disabled } : {}),
    ...(typeof record.checked === "boolean" ? { checked: record.checked } : {}),
    ...(typeof record.selected === "boolean" ? { selected: record.selected } : {}),
    ...(typeof record.editable === "boolean" ? { editable: record.editable } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
