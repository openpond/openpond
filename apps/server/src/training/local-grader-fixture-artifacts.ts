import path from "node:path";
import { z } from "zod";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import { decodeTasksetPackageFile } from "openpond-sdk/taskset-packages";

/** Authored examples reference sealed private package files, never host paths
 * or a target model's claimed output. These bytes remain evaluator-only. */
export function localGraderFixtureArtifacts(value:TasksetPackage,fixture:{id:string;metadata:Record<string,unknown>}) {
  const ids=z.array(z.string().min(1).max(240)).max(16).parse(fixture.metadata.artifactAssetIds ?? []);
  if(new Set(ids).size!==ids.length)throw new Error("An artifact fixture contains duplicate assets.");
  let size=0;
  return ids.map(id=>{
    const files=value.files.filter(file=>file.asset.id===id);
    const file=files[0];
    if(files.length!==1||!file||file.asset.visibility!=="host_private")throw new Error("Artifact fixtures require a unique private package asset.");
    const bytes=decodeTasksetPackageFile(file);
    if((size+=bytes.length)>20_000_000)throw new Error("Artifact fixtures exceed their aggregate byte limit.");
    return {reference:{id:`fixture/${fixture.id}/${file.asset.path}`,contentHash:file.asset.contentHash,mediaType:file.asset.mediaType,sizeBytes:file.asset.sizeBytes},
      title:path.posix.basename(file.asset.path),contentType:file.asset.mediaType,base64:Buffer.from(bytes).toString("base64")};
  });
}
