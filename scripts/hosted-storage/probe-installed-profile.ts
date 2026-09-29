import path from "node:path";
import { initLocalProfileRepo, registerLocalProfileRepo,
  loadOpenPondProfileLibrary } from "@openpond/cloud";

const home = process.env.OPENPOND_HOME;
if (!home) throw new Error("Set disposable OPENPOND_HOME.");
const repoPath = path.join(home, "library", "profiles", "default-repo");
await initLocalProfileRepo({ repoPath, profile: "legacy", template: "blank-agent" });
const profile = await registerLocalProfileRepo(repoPath, "legacy", {
  source: "openpond_git", repositoryId: "probe/legacy",
});
const library = await loadOpenPondProfileLibrary();
if (profile.git?.head === null || library.lastUsed?.source !== "openpond_git" ||
    library.lastUsed.repositoryId !== "probe/legacy" ||
    library.lastUsed.profileId !== "legacy") {
  throw new Error("Installed Profile did not persist its Git identity.");
}
console.log(JSON.stringify({ repoPath, gitHead: profile.git?.head,
  lastUsed: library.lastUsed }));
