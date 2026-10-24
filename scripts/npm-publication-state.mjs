import { spawnSync } from "node:child_process";

// A registry outage or failed authentication is not evidence of absence. Keep
// npm's normal configured registry/auth adapter and expose no raw error body.
const [name, version] = process.argv.slice(2);
if (!["openpond-sdk", "ponder-sdk"].includes(name) ||
    (version !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))) {
  throw new Error("Expected a supported SDK name and optional stable version");
}
const result = spawnSync("npm", ["view", version ? `${name}@${version}` : name, version ? "version" : "name", "--json"], {
  encoding: "utf8", timeout: 20_000, maxBuffer: 262_144,
});
let value;
try { value = JSON.parse(result.stdout); } catch { /* Unknown remains refusal. */ }
if (!result.error && result.status === 0 && value === (version ?? name)) {
  console.log("present");
} else if (!result.error && result.status !== 0 && value?.error?.code === "E404") {
  console.log("absent");
} else {
  throw new Error("npm publication state is unknown; refusing release reconciliation");
}
