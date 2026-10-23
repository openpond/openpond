import type { z } from "zod";

/** These scopes belong exclusively to the app resource, never organization actions. */
export const OPENPOND_APP_MCP_SCOPES = [
  "app:read",
  "app:write",
  "app:execute",
  "app:publish",
  "app:cancel",
  "app:review",
  "app:learning",
] as const;
export type OpenPondMcpScope = (typeof OPENPOND_APP_MCP_SCOPES)[number];
export interface OpenPondMcpContext {
  userId: string;
  teamId: string;
  scopes: readonly string[];
  /** Revalidate grant, membership and revocation on every discovery/call. */
  authorize: (requiredScopes: readonly OpenPondMcpScope[]) => Promise<void>;
  authorizationChallenge?: (
    code: "invalid_token" | "insufficient_scope",
    scopes: readonly string[],
  ) => string;
}
export interface OpenPondMcpOptions {
  baseUrl: string;
  context: OpenPondMcpContext;
  /** A supported API credential, or a host-provided authenticated transport. */
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  maximumResultBytes?: number;
}
export interface ToolDefinition {
  name: string;
  description: string;
  input: z.ZodType;
  output?: z.ZodType;
  wireOutput?: z.ZodType;
  scopes: readonly OpenPondMcpScope[];
  effect: "read" | "write" | "execute" | "publish" | "cancel" | "review" | "learning";
  idempotent: boolean;
  run: (input: never) => Promise<unknown>;
}
export type AddTool = <T extends z.ZodType>(
  name: string,
  description: string,
  input: T,
  effect: ToolDefinition["effect"],
  run: (input: z.output<T>) => Promise<unknown>,
  options?: {
    output?: z.ZodType;
    wireOutput?: z.ZodType;
    idempotent?: boolean;
    scopes?: readonly OpenPondMcpScope[];
  },
) => void;

export class OpenPondMcpAuthorizationError extends Error {
  constructor(
    readonly code: "invalid_token" | "insufficient_scope",
    readonly requiredScopes: readonly string[] = [],
  ) {
    super(code);
    this.name = "OpenPondMcpAuthorizationError";
  }
}

/** `T` is the unchanged, fully verified public SDK result contract. */
export interface OpenPondMcpStructuredResult<T> {
  result: T;
}
