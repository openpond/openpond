import path from "node:path";

export type RepositoryFile = {
  path: string;
  size: number;
  sha?: string;
};

export type RepositorySourceClient = {
  listFiles(directory: string): Promise<RepositoryFile[]>;
  readBytes(filePath: string): Promise<Uint8Array>;
};

export type PinnedGitHubRepositorySource = {
  repository: string;
  revision: string;
  userAgent?: string;
};

/**
 * Creates a read-only client for an immutable GitHub repository revision.
 * Benchmark-specific paths, task mappings, splits, and graders deliberately
 * remain outside the SDK and belong to the importing Taskset package.
 */
export function createPinnedGitHubRepositoryClient(
  source: PinnedGitHubRepositorySource,
  fetcher: typeof fetch = fetch,
): RepositorySourceClient {
  const repository = safeRepositoryName(source.repository);
  const revision = safeRevision(source.revision);
  const userAgent = source.userAgent?.trim() || "openpond-taskset-sdk";
  return {
    async listFiles(directory) {
      const safePath = safeRepositoryPath(directory);
      const encodedPath = safePath.split("/").map(encodeURIComponent).join("/");
      const response = await fetcher(
        `https://api.github.com/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(revision)}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": userAgent,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!response.ok) {
        throw new Error(
          `GitHub repository listing failed: ${response.status} ${response.statusText}`,
        );
      }
      const entries = await response.json() as Array<{
        path: string;
        type: string;
        size: number;
        sha: string;
      }>;
      return entries
        .filter((entry) => entry.type === "file")
        .map((entry) => ({
          path: safeRepositoryPath(entry.path),
          size: entry.size,
          sha: entry.sha,
        }));
    },
    async readBytes(filePath) {
      const safePath = safeRepositoryPath(filePath);
      const response = await fetcher(
        `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(revision)}/${safePath}`,
        { headers: { "User-Agent": userAgent } },
      );
      if (!response.ok) {
        throw new Error(
          `Unable to fetch pinned repository file ${safePath}: ${response.status} ${response.statusText}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

export function safeRepositoryPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe repository path: ${value}`);
  }
  return normalized;
}

export function mediaTypeForRepositoryFile(fileName: string): string {
  switch (path.posix.extname(fileName).toLowerCase()) {
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pdf":
      return "application/pdf";
    case ".eml":
      return "message/rfc822";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function safeRepositoryName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error(`Invalid GitHub repository name: ${value}`);
  }
  return normalized;
}

function safeRevision(value: string): string {
  const normalized = value.trim();
  if (!normalized || /[\s/?#]/.test(normalized)) {
    throw new Error(`Invalid repository revision: ${value}`);
  }
  return normalized;
}
