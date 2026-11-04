import { createContext } from "react";

/** Real shell identity; display labels and serialized picker keys are not auth. */
export const ChatExperimentWorkspaceContext = createContext<{
  accountKey: string;
  teamId: string | null;
  actorId: string | null;
} | null>(null);
