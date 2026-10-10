import type { Experience, ProductArea } from "@openpond/contracts";
import type { AppView } from "./app-models";

export function productAreaForAppView(
  view: AppView,
  _experience: Experience
): ProductArea {
  if (view === "labs") return "models";
  if (view === "chat") {
    return "chat";
  }
  if (view === "team" || view === "community") return "chat";
  if (view === "scheduled" || view === "outputs" || view === "projects") return "chat";
  if (view === "apps") return "chat";
  return "chat";
}
