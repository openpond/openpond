import { describe, expect, test } from "vitest";
import {
  emptyOpenPondProfileState,
  type OpenPondProfileCatalogEntry,
} from "@openpond/contracts";
import { profileScheduleSourceCatalogForLibrary } from "../apps/server/src/agents/local-agent-scheduler";

function profileEntry(
  repositoryId: string,
  profileId: string,
): OpenPondProfileCatalogEntry {
  const repoPath = `/profiles/${profileId}`;
  return {
    ref: { source: "local", repositoryId, profileId },
    name: profileId,
    repoPath,
    sourcePath: `${repoPath}/profiles/${profileId}`,
    state: {
      ...emptyOpenPondProfileState(),
      mode: "local",
      repoPath,
      activeProfile: profileId,
      sourcePath: `${repoPath}/profiles/${profileId}`,
      agents: [{ id: "default", name: "default", path: "agent/agent.ts", enabled: true }],
    },
  };
}

describe("Profile-backed local schedule discovery", () => {
  test("keeps all installed identities but inspects only the last-used Profile", () => {
    const active = profileEntry("/profiles/active", "active");
    const installed = profileEntry("/profiles/installed", "installed");
    const catalog = profileScheduleSourceCatalogForLibrary({
      lastUsed: active.ref,
      profiles: [active, installed],
    });
    expect(catalog.installedSourceIds.size).toBe(2);
    expect(catalog.sourcesToInspect).toHaveLength(1);
    expect(catalog.sourcesToInspect[0]?.agentRootPath).toBe(active.state.sourcePath);
  });
});
