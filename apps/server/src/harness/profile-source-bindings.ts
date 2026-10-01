import path from "node:path";
import type {HarnessSourceManifest} from "@openpond/contracts";
import {copyRegularFile} from "./local-harness-workspace-files.js";

/** Record compiler-known original paths, including overlapping public Agent
 * assets. Byte equality is never used to decide source ownership or aliases. */
export function createProfileSourceBindings(profileSource:string,sourceDir:string) {
  const bindings:Array<{releasedPath:string;profileRelativePath:string}>=[];
  return {
    async copy(source:string,destination:string){
      await copyRegularFile(source,destination);
      const relative=path.relative(profileSource,source),released=path.relative(sourceDir,destination);
      if(relative&&!relative.startsWith("..")&&!path.isAbsolute(relative))bindings.push({releasedPath:released.split(path.sep).join("/"),profileRelativePath:relative.split(path.sep).join("/")});
    },
    add(releasedPath:string,profileRelativePath:string){bindings.push({releasedPath,profileRelativePath});},
    policy(files:HarnessSourceManifest["files"]){return bindings.filter(binding=>files.some(file=>file.path===binding.releasedPath&&file.visibility==="policy"));}
  };
}

export const isProfilePrivateEvaluationPath=(file:string)=>file==="evals/catalog.json"||/^evals\/(definitions|suites|tasksets)\//.test(file)||/^workflows\/[^/]+\/evals\//.test(file);
