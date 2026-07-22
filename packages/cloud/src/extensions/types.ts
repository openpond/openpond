export type ExtensionValidationStatus = "valid" | "error";

export type OpenPondExtensionSkill = {
  name: string;
  description: string;
  relativePath: string;
  sourcePath: string;
  charCount: number;
  sourceHash: string;
  resourceFiles: string[];
  validationStatus: ExtensionValidationStatus;
  validationMessages: string[];
};

export type OpenPondExtension = {
  id: string;
  source: "github";
  owner: string;
  repo: string;
  repositoryUrl: string;
  requestedRef: string;
  resolvedCommit: string;
  sourcePath: string;
  readmePath: string | null;
  installedAt: string;
  updatedAt: string;
  packageHash: string;
  skills: OpenPondExtensionSkill[];
  validationStatus: ExtensionValidationStatus;
  validationMessages: string[];
};

export type OpenPondExtensionPreview = Omit<
  OpenPondExtension,
  "installedAt" | "updatedAt" | "sourcePath"
> & { sourcePath: null };

export type OpenPondExtensionCatalog = {
  rootPath: string;
  registryPath: string;
  extensions: OpenPondExtension[];
  error: string | null;
};

export type GithubExtensionIdentity = {
  id: string;
  owner: string;
  repo: string;
  repositoryUrl: string;
};

export type GithubExtensionInstallRequest = {
  source: string;
  ref?: string | null;
};

export type GithubExtensionManagerOptions = {
  rootPath?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  githubToken?: string | null;
  reservedSkillNames?: string[] | (() => Promise<string[]>);
};

export type GithubExtensionUpdateAllResult = {
  updated: OpenPondExtension[];
  unchanged: OpenPondExtension[];
  failed: Array<{ id: string; error: string }>;
};

export type OpenPondExtensionSkillReadResult = {
  name: string;
  description: string;
  body: string;
  path: string;
  sourcePath: string;
  sourceHash: string;
  charCount: number;
  packagePath: string;
  resourceFiles: string[];
};

export class GithubExtensionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: { code: string; status?: number }) {
    super(message);
    this.name = "GithubExtensionError";
    this.code = options.code;
    this.status = options.status ?? 400;
  }
}
