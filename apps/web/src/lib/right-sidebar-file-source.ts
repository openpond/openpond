import type { WorkspaceTargetValue } from "./workspace-location";

export type RightSidebarFileSource = "local" | "sandbox";

export type RightSidebarFileSourceOption = {
  value: RightSidebarFileSource;
  label: string;
};

export function resolveRightSidebarFileSource(input: {
  workspaceTarget: WorkspaceTargetValue;
  localWorkspaceId: string | null | undefined;
  sandboxSourceAvailable?: boolean;
  sandboxWorkspaceId: string | null | undefined;
  override: RightSidebarFileSource | null | undefined;
}): {
  source: RightSidebarFileSource | null;
  options: RightSidebarFileSourceOption[];
} {
  const options: RightSidebarFileSourceOption[] = [];
  if (input.localWorkspaceId) options.push({ value: "local", label: "Local" });
  if (input.sandboxSourceAvailable ?? Boolean(input.sandboxWorkspaceId)) {
    options.push({ value: "sandbox", label: "Sandbox" });
  }

  if (options.length === 0) return { source: null, options };

  const available = new Set(options.map((option) => option.value));
  if (input.override && available.has(input.override)) return { source: input.override, options };

  const targetSource: RightSidebarFileSource =
    input.workspaceTarget === "local" ? "local" : "sandbox";
  if (available.has(targetSource)) return { source: targetSource, options };

  return { source: options[0]!.value, options };
}
