import { z } from "zod";
import type { AppServerToolBinding } from "../../apps/server/src/app-server-runtime.js";
import { type ExternalChatInput, type ExternalConfig, ExampleError } from "./config.js";
import { readResponseJson } from "./http-json.js";

export const hashInput = z.object({ text: z.string().max(4096) }).strict();
export const hashTool = {
  name: "sandbox_sha256",
  description: "Compute SHA-256 of the exact UTF-8 text by executing a command in the authorized external Firecracker sandbox. Use this tool when asked for a hash; never invent its output.",
  sideEffect: "read" as const, timeoutMs: 30_000, inputSchema: hashInput,
};
export type ToolEvidence = { sandboxId: string; commandId: string; sha256: string };
const sandboxSchema = z.object({ id: z.string(), teamId: z.string() });

export function createHashTool(config: ExternalConfig, credentials: ExternalChatInput["credentials"],
  requestSignal: AbortSignal, evidence: ToolEvidence[]): AppServerToolBinding {
  let invoked = false;
  return {
    name: hashTool.name, version: "1", inputSchema: hashInput,
    async execute({ args, signal }) {
      // One read-only execution per request, including when an upstream result is ambiguous.
      if (invoked) throw new ExampleError("sandbox_tool_already_invoked");
      invoked = true;
      const combined = AbortSignal.any([signal, requestSignal, AbortSignal.timeout(30_000)]);
      const url = `${config.sandboxEndpoint.replace(/\/$/, "")}/${config.sandboxId}`;
      const headers = { "openpond-api-key": credentials.sandboxApiKey, "content-type": "application/json" };
      const owned = (payload: unknown) => {
        const { sandbox } = z.object({ sandbox: sandboxSchema }).parse(payload);
        if (sandbox.id !== config.sandboxId || sandbox.teamId !== config.sandboxTeamId)
          throw new ExampleError("sandbox_owner_mismatch", 403);
      };
      owned(await readResponseJson(await fetch(url, { headers, signal: combined, redirect: "error" })));
      const { text } = hashInput.parse(args);
      // Base64 only: model/user content cannot become shell syntax or select a different command.
      const encoded = Buffer.from(text, "utf8").toString("base64");
      const payload = await readResponseJson(await fetch(`${url}/exec`, {
        method: "POST", headers, signal: combined, redirect: "error",
        body: JSON.stringify({ command: `printf '%s' '${encoded}' | base64 -d | sha256sum`, timeoutSeconds: 15 }),
      }));
      owned(payload);
      const { command } = z.object({ command: z.object({
        id: z.string().min(1), exitCode: z.literal(0), status: z.literal("succeeded"), output: z.string().max(4096),
      }) }).parse(payload);
      const match = /^([a-f0-9]{64})\s+-\s*$/.exec(command.output.trim());
      if (!match) throw new ExampleError("invalid_sandbox_hash");
      const result = { sandboxId: config.sandboxId, commandId: command.id, sha256: match[1]! };
      evidence.push(result);
      return result;
    },
  };
}
