import type {
  SandboxGitBranchResponse,
  SandboxGitCommitResponse,
  SandboxGitDiffResponse,
  SandboxGitPullResponse,
  SandboxGitPushResponse,
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
  sandboxGitBranch: (
    connection: ClientConnection,
    sandboxId: string,
    input: { branch: string; create?: boolean; startPoint?: string },
  ) =>
    apiFetch<SandboxGitBranchResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/git/branch`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  sandboxGitCommit: (
    connection: ClientConnection,
    sandboxId: string,
    input: { message: string; paths?: string[]; all?: boolean },
  ) =>
    apiFetch<SandboxGitCommitResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/git/commit`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  sandboxGitPull: (
    connection: ClientConnection,
    sandboxId: string,
    input: { remote?: string; branch?: string; rebase?: boolean; ffOnly?: boolean },
  ) =>
    apiFetch<SandboxGitPullResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/git/pull`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  sandboxGitPush: (
    connection: ClientConnection,
    sandboxId: string,
    input: {
      remote?: string;
      branch?: string;
      setUpstream?: boolean;
      forceWithLease?: boolean;
    },
  ) =>
    apiFetch<SandboxGitPushResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/git/push`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
};
