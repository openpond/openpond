export type AcpObject = Record<string, unknown>;
export type AcpPermissionOption = { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" };
export type AcpPermissionRequest = { sessionId: string; toolCall: AcpObject; options: AcpPermissionOption[] };
export type AcpPermissionResult = { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } };
export type AcpInitializeResult = {
  protocolVersion: number;
  agentInfo?: { name: string; version: string };
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    sessionCapabilities?: { list?: AcpObject; close?: AcpObject; resume?: AcpObject };
  };
  authMethods?: Array<{ id: string; name: string; description?: string; type?: string; _meta?: AcpObject }>;
};
export type AcpSessionResult = {
  sessionId: string;
  modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string }> };
  models?: { currentModelId: string; availableModels: Array<{ modelId: string; name: string; description?: string }> };
  configOptions?: AcpObject[];
};
export type AcpClientOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onUpdate?: (sessionId: string, update: AcpObject) => void | Promise<void>;
  onPermission?: (request: AcpPermissionRequest, signal: AbortSignal) => Promise<AcpPermissionResult>;
  onExit?: (error: Error) => void;
};

export class AcpRpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
    this.name = "AcpRpcError";
  }
}
