export type HarnessMemoryEntry = {
  schemaVersion: "openpond.harnessMemoryEntry.v1";
  id: string;
  workspaceId: string;
  key: string;
  content: string;
  tags: string[];
  revision: number;
  status: "active" | "deleted";
  sourceRunId: string | null;
  sourceProposal: { id: string; contentHash: string } | null;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
};

export type HarnessMemoryWrite = {
  workspaceId: string;
  key: string;
  content: string | null;
  tags?: string[];
  expectedRevision: number | null;
  sourceRunId: string | null;
  sourceProposal: { id: string; contentHash: string } | null;
  createdAt: string;
};
