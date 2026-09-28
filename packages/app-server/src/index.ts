import {
  createAgentRuntimeService,
  runAgentJsonlServer,
  type AgentRuntimeHost,
  type AgentRuntimeServicePorts,
  type AgentHostStorageClient,
} from "@openpond/agent-runtime";
import type { Readable, Writable } from "node:stream";

export type AppServerInstance = {
  runtime: AgentRuntimeHost;
  close(): Promise<void>;
};

export function createAppServer<TThread, TTurn, TEvent, TApproval>(input: {
  ports: AgentRuntimeServicePorts<TThread, TTurn, TEvent, TApproval>;
  close?: () => Promise<void>;
}): AppServerInstance {
  return attachAppServer({
    runtime: createAgentRuntimeService(input.ports),
    close: input.close,
  });
}

export function attachAppServer(input: {
  runtime: AgentRuntimeHost;
  close?: () => Promise<void>;
}): AppServerInstance {
  let closed = false;
  return {
    runtime: input.runtime,
    close: async () => {
      if (closed) return;
      closed = true;
      await input.close?.();
    },
  };
}

export async function runAppServerJsonl(input: {
  appServer: AppServerInstance | (() => Promise<AppServerInstance>);
  readable: Readable;
  writable: Writable;
  hostStorageClient?: AgentHostStorageClient;
}): Promise<void> {
  let created: AppServerInstance | null = typeof input.appServer === "function" ? null : input.appServer;
  try {
    await runAgentJsonlServer({
      host: created?.runtime ?? (async () => {
        created = await (input.appServer as () => Promise<AppServerInstance>)();
        return created.runtime;
      }),
      readable: input.readable,
      writable: input.writable,
      hostStorageClient: input.hostStorageClient,
    });
  } finally {
    await created?.close();
  }
}
