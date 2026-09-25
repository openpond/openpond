import { preparePackageRelease } from "./prepare-package-release";

void preparePackageRelease("harness").catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
