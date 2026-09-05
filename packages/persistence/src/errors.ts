export type PersistenceIssue = {
  code: string;
  message: string;
  path: string;
  line?: number;
  column?: number;
  action: string;
};

export class PersistenceError extends Error {
  readonly issue: PersistenceIssue;
  constructor(issue: PersistenceIssue, options?: ErrorOptions) {
    super(issue.message, options);
    this.name = "PersistenceError";
    this.issue = issue;
  }
}

export function persistenceIssue(error: unknown, filePath: string): PersistenceIssue {
  if (error instanceof PersistenceError) return error.issue;
  return { code: "STORAGE_UNAVAILABLE", path: filePath, message: "OpenPond could not access its storage.", action: "Check the folder permissions and available disk space, then retry." };
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
