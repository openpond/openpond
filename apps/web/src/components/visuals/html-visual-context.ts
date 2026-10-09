import { createContext } from "react";
import type { HtmlVisualReference } from "@openpond/contracts/html-visuals";

export const OpenHtmlVisualContext = createContext<((visual: HtmlVisualReference) => void) | null>(null);
