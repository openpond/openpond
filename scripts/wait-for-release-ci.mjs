import { setTimeout } from "node:timers/promises";
import { hasTrustedCiProof } from "./package-release-scope.mjs";

const sha = process.env.RELEASE_SHA;
if (!sha) throw new Error("RELEASE_SHA is required");
for (let attempt = 1; attempt <= 60; attempt++) {
  if (await hasTrustedCiProof(sha)) {
    console.log(`Verified latest master CI and Checks for ${sha}`);
    process.exit(0);
  }
  console.log(`Waiting for trusted CI proof on ${sha} (${attempt}/60)`);
  await setTimeout(10_000);
}
throw new Error(`No successful trusted CI proof for ${sha}; refusing publication`);
