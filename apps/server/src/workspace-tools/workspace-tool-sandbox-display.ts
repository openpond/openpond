import {
  SANDBOX_TEMPLATE_PREVIEW_PORT_MAX,
  SANDBOX_TEMPLATE_PREVIEW_PORT_MIN,
} from "@openpond/contracts";
import { stringArg } from "./workspace-tool-arguments.js";

export function sandboxCatalogPayload(
  args: Record<string, unknown>
): Record<string, unknown> {
  return {
    teamId: stringArg(args, "teamId", ""),
    projectId: stringArg(args, "projectId", ""),
    agentId: stringArg(args, "agentId", ""),
    q: stringArg(args, "q", ""),
    name: stringArg(args, "name", ""),
    version: stringArg(args, "version", ""),
    tag: stringArg(args, "tag", ""),
    useCase: stringArg(args, "useCase", ""),
  };
}

export function previewPortArg(
  args: Record<string, unknown>
): number | undefined {
  const value = Number(args.previewPort);
  if (
    !Number.isInteger(value) ||
    value < SANDBOX_TEMPLATE_PREVIEW_PORT_MIN ||
    value > SANDBOX_TEMPLATE_PREVIEW_PORT_MAX
  ) {
    return undefined;
  }
  return value;
}

export function sandboxName(sandbox: Record<string, unknown>): string {
  const repo = typeof sandbox.repo === "string" ? sandbox.repo : "";
  if (!repo) return typeof sandbox.id === "string" ? sandbox.id : "Sandbox";
  const trimmed = repo.replace(/\.git$/, "").replace(/\/$/, "");
  const parts = trimmed.split("/");
  return parts.slice(-2).join("/");
}
