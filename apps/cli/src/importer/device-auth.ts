import {
  createHash,
  generateKeyPairSync,
  createPublicKey,
  diffieHellman,
  createDecipheriv,
} from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { loadConfig, saveProfileApiKey } from "../config";
import {
  optionString,
  resolveBaseUrl,
  resolveApiBaseUrlOption,
} from "../cli/common";
import { DEFAULT_OPENPOND_API_BASE_URL } from "../urls";
import type { NativeSource } from "@openpond/evals/native-conversations";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const Envelope = z
  .object({
    publicKey: z.string().max(200),
    iv: z.string().max(100),
    tag: z.string().max(100),
    ciphertext: z.string().max(10000),
  })
  .strict();
async function post(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (text.length > 16384)
    throw new Error("Authorization response exceeded its limit.");
  if (!response.ok)
    throw Object.assign(
      new Error(`Browser sign-in failed (${response.status}).`),
      { status: response.status },
    );
  return JSON.parse(text);
}
function openBrowser(url: string) {
  const executable =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(executable, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
export async function authorizeImporter(
  source: NativeSource,
  options: Record<string, string | boolean>,
) {
  const config = await loadConfig(),
    configuredApi =
      resolveApiBaseUrlOption(options) ||
      config.apiBaseUrl ||
      DEFAULT_OPENPOND_API_BASE_URL;
  const configuredWeb =
    optionString(options, "baseUrl") ||
    (new URL(configuredApi).hostname === "staging-api.openpond.ai"
      ? "https://staging.openpond.ai"
      : resolveBaseUrl(config));
  const origin = new URL(configuredWeb),
    api = new URL(configuredApi);
  for (const url of [origin, api])
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Sign-in requires a clean HTTPS origin or local development origin.",
      );
  const account = `import-${hash([origin.origin, source.machineId, source.instanceId].join(":")).slice(0, 24)}`;
  // Explicit browser approval is used for connection setup; service reuses this dedicated encrypted credential.
  const keys = generateKeyPairSync("x25519"),
    publicKey = keys.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
  const result = z
    .object({
      deviceCode: z.string(),
      userCode: z.string(),
      expiresAt: z.string().datetime(),
      intervalSeconds: z.number().min(2).max(10),
    })
    .strict()
    .parse(
      await post(origin.origin, "/api/cli/import/device", {
        publicKey,
        machineId: source.machineId,
        sourceInstanceId: source.instanceId,
        sourceLabel: source.source,
        sourceRoot: source.root,
        ...(optionString(options, "team")
          ? { requestedTeamId: optionString(options, "team") }
          : {}),
      }),
    );
  const url = `${origin.origin}/console/connections/authorize?code=${encodeURIComponent(result.userCode)}`;
  console.log(`OpenPond sign-in code: ${result.userCode}\n${url}`);
  openBrowser(url);
  while (Date.now() < Date.parse(result.expiresAt)) {
    await new Promise((resolve) =>
      setTimeout(resolve, result.intervalSeconds * 1000),
    );
    let poll: unknown;
    try {
      poll = await post(origin.origin, "/api/cli/import/token", {
        deviceCode: result.deviceCode,
      });
    } catch (error) {
      if (Number((error as { status?: number }).status) === 429) continue;
      throw error;
    }
    const status = z
      .object({
        state: z.enum(["pending", "approved", "denied", "consumed"]),
        envelope: Envelope.nullable().optional(),
      })
      .strict()
      .parse(poll);
    if (status.state === "denied" || status.state === "consumed")
      throw new Error(
        "Browser sign-in was declined or already consumed. Start the connection again.",
      );
    if (status.state !== "approved" || !status.envelope) continue;
    const envelope = status.envelope,
      serverKey = createPublicKey({
        key: Buffer.from(envelope.publicKey, "base64"),
        format: "der",
        type: "spki",
      });
    if (serverKey.asymmetricKeyType !== "x25519")
      throw new Error("Invalid sign-in encryption key.");
    const shared = createHash("sha256")
        .update(
          diffieHellman({ privateKey: keys.privateKey, publicKey: serverKey }),
        )
        .digest(),
      decipher = createDecipheriv(
        "aes-256-gcm",
        shared,
        Buffer.from(envelope.iv, "base64"),
      );
    decipher.setAAD(Buffer.from(hash(result.deviceCode)));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const credential = z
      .object({
        apiKey: z.string().min(1),
        teamId: z.string().min(1),
        expiresAt: z.string().datetime(),
      })
      .strict()
      .parse(
        JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, "base64")),
            decipher.final(),
          ]).toString("utf8"),
        ),
      );
    if (
      optionString(options, "team") &&
      credential.teamId !== optionString(options, "team")
    )
      throw new Error("Browser approved a different workspace.");
    await saveProfileApiKey({
      handle: account,
      apiKey: credential.apiKey,
      baseUrl: origin.origin,
      apiBaseUrl: api.origin,
      setActive: false,
    });
    await post(origin.origin, "/api/cli/import/token", {
      deviceCode: result.deviceCode,
      acknowledge: true,
    });
    return {
      apiKey: credential.apiKey,
      teamId: credential.teamId,
      baseUrl: api.origin,
      account,
      accountBaseUrl: origin.origin,
    };
  }
  throw new Error("Browser sign-in expired. Start the connection again.");
}
