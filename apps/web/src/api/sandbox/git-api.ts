import type {
  SandboxGitDiffResponse,
  SandboxGitStatusResponse,
} from "../../lib/sandbox-types";
import {
  apiFetch,
  type ClientConnection,
} from "../api-client";

export const sandboxGitApi = {
  sandboxGitStatus: (connection: ClientConnection, sandboxId: string) =>
    apiFetch<SandboxGitStatusResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/git/status`,
    ),
  sandboxGitDiff: (connection: ClientConnection, sandboxId: string, input: { baseRef?: string }) =>
    apiFetch<SandboxGitDiffResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/git/diff`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
};
