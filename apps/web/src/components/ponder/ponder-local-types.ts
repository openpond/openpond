import type { Session, Turn, ChatProvider } from "@openpond/contracts";
export type LocalPonderAgent = { status: string; session: Session; coordinatorId: string; owner: "ponder" | "user"; revision: number; assignment: string; latestTurn: Turn | null; latestActivity: string | null };
export type LocalPonderState = {
  coordinator: {id: string; location: "local"; sessionId: string | null; modelRef: {providerId: ChatProvider; modelId: string} | null; remoteAccessEnabled: boolean; hostedSandboxesEnabled: boolean; hostedActivation: string; revision: number};
  session: Session | null;
  supportedModelRefs: {providerId: ChatProvider; modelId: string}[];
  capabilities: Record<"remoteAccess" | "hostedSandboxes" | "hostedCoordinator", {available: boolean; reason?: string}>;
};
