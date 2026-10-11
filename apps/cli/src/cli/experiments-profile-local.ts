import { readFile, stat } from "node:fs/promises";
import { createLocalAuthenticatedRequest, DEFAULT_LOCAL_TRAINING_API_URL } from "./training";
import { optionString } from "./common";

const endpoints = {
  "profile-catalog": "/v1/profile/evaluations",
  "prepare-profile": "/v1/profile/evaluations/prepare",
  "run-profile": "/v1/profile/evaluations/run",
  "inspect-profile": "/v1/profile/evaluations/discover",
} as const;

/** Profile workflows own their real tools/artifacts; a text adapter cannot stand
 * in for this runner. Keep its authority and manifest checks in the server. */
export async function runLocalProfileExperimentCommand(
  options: Record<string, string | boolean>,
  rest: string[],
): Promise<boolean> {
  const action = rest[0];
  if (!action || !Object.hasOwn(endpoints, action)) return false;
  if (rest.length !== 1 || options.team || options.revision || options.contentHash) {
    throw new Error("Profile experiments accept one action and exact selection in --input-file; ownership is resolved by the running installation.");
  }
  const base = new URL(optionString(options, "serverUrl") || process.env.OPENPOND_LOCAL_API_URL || DEFAULT_LOCAL_TRAINING_API_URL);
  if (base.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Local Profile experiments require an HTTP loopback server origin.");
  }
  const file = optionString(options, "inputFile");
  let payload: Record<string, unknown> | undefined;
  if (file) {
    const info = await stat(file);
    if (!info.isFile() || info.size > 1_048_576) throw new Error("Profile selection input must be a file within one MiB.");
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Profile selection input must be an object.");
    payload = value as Record<string, unknown>;
  } else if (action !== "profile-catalog") {
    throw new Error(`${action} requires --input-file with the exact Profile or run selection.`);
  }
  const endpoint = action === "profile-catalog" && payload ? endpoints["inspect-profile"] : endpoints[action as keyof typeof endpoints];
  const request = await createLocalAuthenticatedRequest(base.origin, {
    maximumResponseBytes: 32 * 1024 * 1024,
    // The admitted case limit is still enforced by the server. An observer
    // timeout must not cut off a normal 15-minute artifact workflow.
    timeoutMs: action === "run-profile" ? 1_200_000 : 60_000,
  });
  const response = await request(new URL(endpoint, base), {
    method: payload ? "POST" : "GET",
    ...(payload ? { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) } : {}),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const error = result && typeof result === "object" && "error" in result ? result.error : undefined;
    throw new Error(typeof error === "string" ? error : `Local Profile experiment request failed (${response.status}).`);
  }
  console.log(JSON.stringify(result, null, 2));
  return true;
}
