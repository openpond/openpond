import { TrainingHandoffContextSchema } from "openpond-sdk/post-training";
import { canonicalSha256 } from "openpond-sdk/training";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
export function createHostedExperimentTrainingHandoff(input: {
  teamId: string;
  actorId: string;
  access: { apiBaseUrl: string; token: string };
  currentIdentity: () => Promise<{ teamId: string; actorId: string } | null>;
}) {
  async function fence() {
    const current = await input.currentIdentity();
    if (current?.teamId !== input.teamId || current.actorId !== input.actorId)
      throw new Error("The active account changed. Reopen the Experiment result.");
  }
  return {
    async read(executionId: string, passId: string | null = null) {
      await fence();
      const params = new URLSearchParams({ teamId: input.teamId, executionId });
      if (passId) params.set("passId", passId);
      const headers = hostedApiAuthHeaders(input.access.token);
      headers.set("x-openpond-team-id", input.teamId);
      const response = await fetch(
        `${input.access.apiBaseUrl.replace(/\/+$/, "")}/v1/training/experiment-handoff?${params}`,
        { headers, redirect: "error", signal: AbortSignal.timeout(20_000) },
      );
      if (!response.ok)
        throw new Error(`Experiment training handoff is unavailable (${response.status}).`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("The handoff returned no retained evidence.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 262_144) throw new Error("Experiment handoff exceeded its response limit.");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      await fence();
      const value = TrainingHandoffContextSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (value.origin) {
        const { contentHash, ...content } = value.origin;
        if (
          contentHash !== (await canonicalSha256(content)) ||
          content.teamId !== input.teamId ||
          content.source.executionId !== executionId ||
          content.source.passId !== passId
        )
          throw new Error("The handoff does not match the exact selected result.");
      }
      return value;
    },
  };
}
