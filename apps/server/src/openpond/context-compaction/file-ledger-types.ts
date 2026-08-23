export type FileLedgerOperation =
  | "read"
  | "edit"
  | "diff"
  | "command"
  | "validation"
  | "failure";

export type FileLedgerEntry = {
  path: string;
  operations: FileLedgerOperation[];
  relevance: "referenced" | "active" | "validation" | "failed";
  latestStatus: "unknown" | "ok" | "failed";
  failure: string | null;
};
