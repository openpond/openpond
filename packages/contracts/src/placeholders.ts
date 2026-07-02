import { z } from "zod";

export const PlaceholderPaneSchema = z.object({
  key: z.enum([
    "files",
    "diffs",
    "checks",
    "deploys",
    "sources",
    "schedules",
    "tool_runs",
    "logs",
    "app_config",
  ]),
  label: z.string(),
  status: z.enum(["placeholder", "available", "error"]),
  summary: z.string(),
});

export type PlaceholderPane = z.infer<typeof PlaceholderPaneSchema>;

export function createPlaceholderPanes(): PlaceholderPane[] {
  return [
    { key: "files", label: "Files", status: "placeholder", summary: "V2 linked workspace file browser." },
    { key: "diffs", label: "Diffs", status: "placeholder", summary: "V2 local and hosted Change diff view." },
    { key: "checks", label: "Checks", status: "placeholder", summary: "Hosted and local validation status." },
    { key: "deploys", label: "Deploys", status: "placeholder", summary: "Deploy preview and production lifecycle metadata." },
    { key: "sources", label: "Sources", status: "placeholder", summary: "OpenPond Sources configuration and status." },
    { key: "schedules", label: "Schedules", status: "placeholder", summary: "Schedules list is queried on demand for selected apps." },
    { key: "tool_runs", label: "Tool Runs", status: "placeholder", summary: "Tool execution history and safe run controls." },
    { key: "logs", label: "Logs", status: "placeholder", summary: "Local server, hook, provider, and OpenPond action logs." },
    { key: "app_config", label: "Config", status: "placeholder", summary: "App environment, template, and runtime config metadata." },
  ];
}
