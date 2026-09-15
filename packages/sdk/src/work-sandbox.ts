import type { OpenPondSandboxClient } from "@openpond/cloud/sandbox/client";
import type { SandboxRecord } from "@openpond/cloud/sandbox/types";
import type { OpenPondClientOptions } from "./types.js";

/** The operations used by Work; provider-specific provisioning stays here. */
export type WorkSandbox = Pick<OpenPondSandboxClient,
  "get" | "start" | "exec" | "mkdir" | "uploadFile" | "uploadFileBase64" |
  "listFiles" | "downloadFileResponse" | "stop" | "delete"
> & {
  readonly supportsResume: boolean;
  createWork(input: { requestId?: string; repo?: string; budgetUsd?: string; metadata?: Record<string, unknown> }): Promise<SandboxRecord>;
};

export function workSandbox(client: OpenPondSandboxClient, custom?: OpenPondClientOptions["sandbox"]): WorkSandbox {
  return {
    supportsResume: !custom,
    get: (...args) => client.get(...args),
    start: custom ? async () => { throw new Error("This runtime does not support resuming a stopped guest; start fresh Work with saved outputs"); } : (...args) => client.start(...args),
    exec: (id, input) => client.exec(id, custom ? { ...input, timeoutSeconds: Math.min(input.timeoutSeconds ?? 30, 60) } : input),
    mkdir: (...args) => client.mkdir(...args),
    uploadFile: (...args) => client.uploadFile(...args),
    uploadFileBase64: (...args) => client.uploadFileBase64(...args),
    listFiles: (...args) => client.listFiles(...args),
    downloadFileResponse: (...args) => client.downloadFileResponse(...args),
    stop: (...args) => client.stop(...args),
    delete: (...args) => client.delete(...args),
    createWork: ({ requestId, repo, budgetUsd, metadata }) => {
      if (custom) {
        if (repo?.trim()) throw new Error("This runtime does not support repository provisioning; provide Work inputs instead");
        if (budgetUsd !== undefined) throw new Error("Hosted spending budgets are not supported by this runtime");
        const request = { resources: custom.resources ?? { cpu: 1, memoryGb: 2, diskGb: 10 }, ...(requestId ? { requestId } : {}) };
        return client.create(request);
      }
      const budget = budgetUsd?.trim() || "1.00";
      return client.create({
        ...(repo?.trim() ? { repo: repo.trim() } : {}),
        runtimeProfileId: "openpond-work-v1",
        resources: { cpu: 2, memoryGb: 4, diskGb: 16 },
        budget: { maxUsd: budget },
        quotas: { maxSpendUsd: budget, maxDurationSeconds: 3600, idleTimeoutSeconds: 900, maxCommands: 200, maxOpenPorts: 4 },
        metadata: { source: "openpond-sdk-work", ...metadata, ...(requestId ? { workRequestId: requestId } : {}) },
      }, { async: true });
    },
  };
}

export function configuredEndpoint(value: string, name: string): string {
  const endpoint = new URL(value);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error(`${name} must be an HTTP(S) endpoint without embedded credentials, query or fragment`);
  return endpoint.toString().replace(/\/$/, "");
}

export function configuredKey(value: string, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
