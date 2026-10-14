import { createContext } from "react";
import type { HtmlVisualReference, HtmlVisualResourceSelection } from "@openpond/contracts/html-visuals";

export const OpenHtmlVisualContext = createContext<((visual: HtmlVisualReference) => void) | null>(null);
export const SelectHtmlResourceContext = createContext<((visual:HtmlVisualReference,resource:HtmlVisualResourceSelection,operationId:string)=>Promise<string>) | null>(null);
