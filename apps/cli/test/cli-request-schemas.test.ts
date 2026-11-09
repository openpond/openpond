import { expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/common/args";
import { runCliCommand } from "../src/cli/command-registry";

const account = vi.hoisted(() => vi.fn(async () => { throw new Error("No signed-in account"); }));
vi.mock("../src/cli/hosted-training-account", () => ({ hostedTrainingAccount: account }));

// Failure story: an agent without a prepared request must be able to discover
// real input formats offline, without probing mutations or needing credentials.
test("training and learning request schemas are usable without authentication or network effects", async () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected network request"); });
  const inspect = async (namespace: string, name?: string) => {
    expect(await runCliCommand(parseArgs([namespace, "schema", ...name ? [name] : [], "--json"]))).toBe(true);
    return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  };
  try {
    expect((await inspect("training", "TrainingPreparationRequest")).schema).toMatchObject({
      type: "object", properties: { operationId: { type: "string" }, maximumSpendUsd: { type: "number", exclusiveMinimum: 0 },
        configuration: { type: "object", required: expect.arrayContaining(["id", "expectedRevision", "expectedEtag"]) } },
    });
    expect((await inspect("learning", "SaveAuthoringDraftCommandSchema")).schema).toMatchObject({
      type: "object", properties: { action: { const: "save_draft" }, operationId: { type: "string" }, expectedRevision: { type: "integer" } },
    });
    expect((await inspect("training", "TrainingExperimentSetupRequest")).schema.required).toContain("baseModel");
    expect((await inspect("training")).schemas).toContain("DatasetTrainingReviewRequestSchema");
    await expect(inspect("training", "UnknownRequest")).rejects.toThrow("Unknown training schema");
    expect(account).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});
