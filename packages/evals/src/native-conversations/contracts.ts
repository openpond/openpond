import type { ExternalAgentSource } from "../connected-evidence/imports.js";
export type { ExternalAgentSource };
export interface NativeSource {
  source: ExternalAgentSource;
  machineId: string;
  instanceId: string;
  root: string;
  acquisition: "files" | "sqlite" | "bundle";
  available: boolean;
  capabilities: { history: boolean; live: boolean; nativeResume: boolean };
  reason?: string;
}
export interface NativeSession {
  nativeSessionId: string;
  sourceInstanceId: string;
  path: string;
  title: string;
  cwd: string | null;
  updatedAt: string;
  storageRevision?: string;
  issue?: string;
}
export interface NativeBranchChoice { leafId: string; revision: string }
export interface NativeBranchAnchor { leafId: string; chainHash: string }
export interface NativeBranchInspection {
  revision: string;
  branches: Array<{ leafId: string; chainHash: string; title: string; updatedAt: string | null; messages: number }>;
}
export const NATIVE_SOURCE_NAMES: Record<ExternalAgentSource, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  opencode: "OpenCode",
  grok_build: "Grok Build",
  pi: "Pi",
  oh_my_pi: "Oh My Pi",
};
export const NATIVE_READ_LIMIT = 32 * 1024 * 1024;
