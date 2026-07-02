export type SandboxWorkloadImageSourceInput = {
  ref: string;
  digest?: string;
  registrySecretRef?: string;
  platform?: "linux/amd64";
  workspaceRoot?: string;
};

export type SandboxWorkloadDockerfileSourceInput = {
  context: string;
  path: string;
  target?: string;
  buildArgs?: Record<string, string>;
  registrySecretRefs?: string[];
  platform?: "linux/amd64";
  workspaceRoot?: string;
};

export type SandboxWorkloadSourceInput = {
  image?: SandboxWorkloadImageSourceInput;
  dockerfile?: SandboxWorkloadDockerfileSourceInput;
};
