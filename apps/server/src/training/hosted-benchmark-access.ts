import { ownsHostedBenchmarkVersion, type BenchmarkModelVersion } from "@openpond/contracts/resource-setup";
import { createHostedTrainingRunDetail } from "./hosted-training-run-detail.js";

export type HostedBenchmarkAccess = () => Promise<{ apiBaseUrl: string; token: string; teamId: string; actorId: string }>;
type HostedVersion = Extract<BenchmarkModelVersion, { location: "cloud" }>;

export async function requireHostedBenchmarkAccess(version: HostedVersion, loadAccess: HostedBenchmarkAccess) {
  const access = await loadAccess().catch(() => null);
  const scope = access && { teamId: access.teamId, actorId: access.actorId, apiOrigin: new URL(access.apiBaseUrl).origin };
  if (!access || !scope || version.teamId !== scope.teamId || version.owner && !ownsHostedBenchmarkVersion(version, scope))
    throw new Error("Choose the OpenPond account and workspace that owns this Benchmark.");
  return { ...access, owner: { actorId: scope.actorId, apiOrigin: scope.apiOrigin } };
}

export async function authorizeHostedBenchmarkVersion(version: HostedVersion, loadAccess: HostedBenchmarkAccess): Promise<HostedVersion & { owner: NonNullable<HostedVersion["owner"]> }> {
  const access = await requireHostedBenchmarkAccess(version, loadAccess);
  if (version.owner) return { ...version, owner: version.owner };
  return (await readExactHostedBenchmarkVersion(version, loadAccess, access)).pin;
}

// Older drafts and new composer selections both prove the exact immutable
// version through the existing saved-version route before retaining a pin.
export async function readExactHostedBenchmarkVersion(
  version: HostedVersion, loadAccess: HostedBenchmarkAccess, captured?: Awaited<ReturnType<typeof requireHostedBenchmarkAccess>>,
) {
  const access = captured ?? await requireHostedBenchmarkAccess(version, loadAccess);
  const detail = createHostedTrainingRunDetail({
    ...access,
    access,
    currentIdentity: async () => {
      const active = await loadAccess();
      return { ...active, apiOrigin: new URL(active.apiBaseUrl).origin };
    },
  });
  const saved = await detail.savedVersion(version.modelProjectId, version.versionHash);
  if (saved.version?.schemaVersion !== "openpond.trainingModelVersion.v1" || saved.version.jobId !== version.jobId)
    throw new Error("This exact saved Model version is unavailable.");
  return { model: saved.model, version: saved.version, pin: { ...version, owner: access.owner } };
}
