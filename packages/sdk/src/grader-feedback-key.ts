import { contentHash } from "@openpond/harness";

/** Draft presentation default. Published keys must retain their released value. */
export function graderFeedbackKeyFromName(name: string, rewardId: string): string {
  const slug = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const prefix = /^[a-z]/.test(slug) ? slug : `grader_${slug}`;
  return `${(prefix || "grader").slice(0, 55).replace(/_+$/g, "")}_${contentHash(rewardId).slice(0, 24)}`;
}
