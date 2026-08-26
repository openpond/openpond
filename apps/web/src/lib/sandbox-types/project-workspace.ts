import type { SandboxProject } from "./projects";
import type { SandboxRecord } from "./record";
import type { SandboxRuntimeRecord } from "./runtime";

export type ProjectWorkspaceEnvironment = {
  sandbox: SandboxRecord;
  runtime: SandboxRuntimeRecord | null;
};

export type ProjectDeploymentRelease = {
  id: string;
  version: number;
  status: "pending" | "building" | "ready" | "active" | "retired" | "failed";
  sourceCommitSha: string | null;
  failureCode: string | null;
  createdAt: string;
  readyAt: string | null;
  activatedAt: string | null;
};

export type ProjectDeploymentBuild = {
  id: string;
  attemptNumber: number;
  status: "queued" | "building" | "exporting" | "preparing_runtime" | "succeeded" | "failed" | "cancelled";
  currentStage: string;
  failureCode: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ProjectDeploymentSummary = {
  release: ProjectDeploymentRelease;
  build: ProjectDeploymentBuild | null;
  creatorName: string | null;
};

export type ProjectRuntimeTraceStage = {
  name: string;
  status: "success" | "failure" | "skipped";
  durationMs: number;
  errorCode?: string;
};

export type ProjectRuntimeTrace = {
  id: string;
  releaseId: string;
  startedAt: string;
  method: string;
  path: string;
  outcome: "success" | "failure";
  responseStatus: number;
  coldStart: boolean | null;
  totalDurationMs: number;
  errorCode?: string;
  stages: ProjectRuntimeTraceStage[];
};

export type ProjectWebsite = {
  settings: {
    appId: string;
    projectId: string | null;
    platformDomain: string;
    status: "active" | "suspended" | "deleted";
    activeReleaseId: string | null;
    runtimePolicy?: {
      availabilityMode?: "on_demand" | "always_on";
    };
  };
  releases: ProjectDeploymentRelease[];
};

export type ProjectWebsiteDatabase = {
  status: "pending" | "provisioning" | "ready" | "failed" | "deleting" | "deleted";
  provider: string;
  errorCode: string | null;
};

export type SandboxProjectWorkspaceResponse = {
  project: SandboxProject;
  environments: ProjectWorkspaceEnvironment[];
  deployments: ProjectDeploymentSummary[];
  requests: ProjectRuntimeTrace[];
  website: ProjectWebsite | null;
  database: ProjectWebsiteDatabase | null;
  errors: {
    website: string | null;
    database: string | null;
    deployments: string | null;
    requests: string | null;
  };
};
