export type ResourceReadRequest = {
  ref: string;
  maxBytes?: number;
  mode?: "content" | "summary" | "metadata";
};

export type ResourceSearchRequest = {
  scope: "workspace" | "git" | "events" | "messages" | "artifacts" | "goal-context" | "sandbox";
  query: string;
  limit?: number;
  filters?: Record<string, unknown>;
};

export type ResourceReadResult = {
  ref: string;
  kind: string;
  title: string;
  contentType: string | null;
  contentText?: string;
  summary?: string;
  metadata: Record<string, unknown>;
  relatedRefs: string[];
  truncation: {
    truncated: boolean;
    originalBytes?: number;
    returnedBytes?: number;
    reason?: string;
  };
};

export type ResourceSearchResult = {
  query: string;
  scope: string;
  items: Array<{
    ref: string;
    title: string;
    snippet?: string;
    score?: number;
    metadata: Record<string, unknown>;
  }>;
  truncated: boolean;
};
