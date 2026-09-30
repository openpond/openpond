import { z } from "zod";
import type { TasksetRunManifest } from "@openpond/evals";

/** An embedding host must prove the exact admitted ceiling with the scoped
 * runtime credential. Local runs cannot self-assert hosted budget enforcement. */
export async function assertProfileEvaluationSpendAuthority(
  manifest: TasksetRunManifest,
  signal?: AbortSignal,
) {
  if (manifest.limits.maximumSpendUsd === null) return;
  const token = process.env.OPENPOND_API_KEY?.trim();
  const baseUrl = process.env.OPENPOND_OPCHAT_API_URL?.trim();
  if (!token || !baseUrl) throw new Error("Profile evaluation requires an admitted hosted spend ceiling.");
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/experiment-budget`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Profile evaluation spend authority URL is invalid.");
  url.searchParams.set("runId", manifest.id);
  url.searchParams.set("manifestHash", manifest.contentHash);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
  if (!response.ok) throw new Error("The exact Profile evaluation spend ceiling is unavailable.");
  const authority = z.object({ runId: z.string(), manifestHash: z.string(), maximumCostUsd: z.number().positive() })
    .strict().parse(await response.json());
  if (authority.runId !== manifest.id || authority.manifestHash !== manifest.contentHash
    || authority.maximumCostUsd !== manifest.limits.maximumSpendUsd)
    throw new Error("Profile evaluation spend authority differs from its admitted manifest.");
}
