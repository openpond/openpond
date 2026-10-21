import type { Taskset } from "@openpond/contracts";
import { ImmutableAssetRefSchema } from "@openpond/harness";
import { validateTasksetPackage, type TasksetPackage } from "openpond-sdk/taskset-packages";

/** Resolve existing review of these exact workflow bytes. PDF review cannot
 * approve new executable files, and generic imports remain pending. */
export function reviewedModelSharedResources(reviewed: Taskset, input?: TasksetPackage) {
  if (!input) return null;
  const source = validateTasksetPackage(input);
  const declarations = (reviewed.environment.resources ?? []).filter(resource => resource.kind === "file" && resource.visibility === "policy_visible");
  if (!declarations.length) return null;
  const assets = declarations.map(resource => {
    const matches = source.files.filter(file => file.asset.path === resource.path && file.asset.visibility === "policy");
    if (matches.length !== 1) throw new Error("Reviewed shared resource differs from the exact owner-local package.");
    const asset = ImmutableAssetRefSchema.parse(matches[0]!.asset);
    const sourceRef = reviewed.sourceRefs.find(ref => "sourceFileHashes" in ref
      && ref.sourceFileHashes?.includes(asset.contentHash)
      && "originalFileNames" in ref && ref.originalFileNames?.includes(asset.path.split("/").at(-1)!)
      && "mediaTypes" in ref && ref.mediaTypes?.includes(asset.mediaType));
    if (!sourceRef) throw new Error("Shared workflow files require existing source review of their exact bytes.");
    return { asset, sourceRefId: sourceRef.id };
  });
  return new Map(assets.map(value => [value.asset.id, value]));
}
