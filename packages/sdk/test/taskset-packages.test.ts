import { expect, it } from "vitest";
import { contentHash, sha256 } from "@openpond/harness";
import { bindTasksetExecutionReleases, createEnvironmentRelease, createVerifierSetRelease } from "@openpond/evals";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { createTasksetPackage, decodeTasksetPackageFile, validateTasksetPackage, OpenPondTasksetPackageClient, type TasksetPackagePublication } from "../src/taskset-packages.js";

function fixture() {
  const file = (id: string, bytes: Uint8Array, visibility: "policy" | "host_private" | "verifier") => ({
    asset: { id, path: `assets/${id}`, mediaType: "application/octet-stream", sizeBytes: bytes.byteLength, contentHash: sha256(bytes), visibility },
    base64: Buffer.from(bytes).toString("base64"),
  });
  const files = [file("binary-input", new Uint8Array([0, 255, 128, 13, 10]), "policy"), file("private-context", new TextEncoder().encode("private expected state"), "host_private"), file("verifier", new TextEncoder().encode("export function verify() { return { score: 1, passed: true }; }"), "verifier"), file("schema", new TextEncoder().encode("{}"), "verifier")];
  const environment = createEnvironmentRelease({
    schemaVersion: "openpond.environmentRelease.v1", id: "work-environment", revision: 1,
    contract: { protocolVersion: "openpond.environment.v1", kind: "work", entrypoint: "work", stateful: true, deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 10_000 },
    actionSchemaRef: files[3]!.asset, observationSchemaRef: null, stateSchemaRef: null,
    artifactCollection: { maxArtifacts: 10, maxTotalBytes: 100_000 }, adapterConformanceHashes: {}, metadata: {},
  });
  const verifierSet = createVerifierSetRelease({
    schemaVersion: "openpond.verifierSetRelease.v1", id: "work-verifiers", revision: 1,
    graders: [{ id: "verify", version: "1", kind: "custom_verifier", weight: 1, hardGate: true, rewardEligible: true, privileged: true, verifierRef: files[2]!.asset, timeoutMs: 1_000, networkPolicy: "none" }],
    isolation: { processBoundary: "isolated_process", networkPolicy: "none", defaultTimeoutMs: 1_000 }, calibrationReceiptRefs: [], metadata: {},
  });
  const content = {
    schemaVersion: "openpond.tasksetRelease.v2", id: "work-tasks", revision: 1,
    policy: { policyVisibleFields: ["input"], privilegedFields: ["expectedOutput"], hiddenGraderRefs: ["verify"], connectedAppScopes: [] },
    environment: environment.contract, tools: [], capabilities: [], graders: verifierSet.graders,
    tasks: [{ id: "task", clusterKey: "family", split: "train", input: { prompt: "Read input" }, expectedOutput: null, policyVisibleContext: {}, privilegedContextRef: "private-context", artifactRefs: [files[0]!.asset], requiredOutputs: [{ path: "output.json", mediaType: "application/json", schemaRef: files[3]!.asset, maxBytes: 1_000, metadata: {} }], tags: [] }], metadata: {},
  };
  const taskset = bindTasksetExecutionReleases({ taskset: TasksetReleaseSchema.parse({ ...content, contentHash: contentHash(content) }), environment, verifierSet });
  return createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset, environment, verifierSet, files });
}

// A metadata-only transfer must not appear complete while Work inputs or
// evaluator dependencies are missing, substituted, or disclosed to the policy.
it("round-trips binary Work packages and enforces their complete private dependency graph", () => {
  const original = fixture();
  expect(validateTasksetPackage(JSON.parse(JSON.stringify(original)))).toEqual(original);
  expect(decodeTasksetPackageFile(original.files[0]!)).toEqual(new Uint8Array([0, 255, 128, 13, 10]));
  for (const file of original.files) {
    const { contentHash: _hash, ...content } = original;
    expect(() => createTasksetPackage({ ...content, files: content.files.filter(value => value.asset.id !== file.asset.id) })).toThrow(/missing/);
  }
  const { contentHash: _hash, ...content } = original;
  expect(() => createTasksetPackage({ ...content, files: [...content.files, content.files[0]!] })).toThrow("Duplicate");
  expect(() => createTasksetPackage({ ...content, files: content.files.map((file, index) => index === 0 ? { ...file, base64: Buffer.from("tampered").toString("base64") } : file) })).toThrow("immutable bytes");
  expect(() => createTasksetPackage({ ...content, files: content.files.map(file => file.asset.id === "private-context" ? { ...file, asset: { ...file.asset, visibility: "policy" } } : file) })).toThrow("private context");
  expect(() => createTasksetPackage({ ...content, environment: { ...content.environment, revision: 2 } })).toThrow("execution releases");
  expect(() => validateTasksetPackage({ ...original, contentHash: "0".repeat(64) })).toThrow("content hash");
});

// A transfer response from a different workspace or release must never become
// a local package or a successful publication receipt, even if it is valid JSON.
it("binds upload receipts and downloaded packages to the requested owner and release", async () => {
  const packageValue = fixture();
  const ref = { id: packageValue.taskset.id, revision: packageValue.taskset.revision, contentHash: packageValue.taskset.contentHash };
  const requests: { url: string; body: string | undefined; team: string | null; redirect: RequestRedirect | undefined }[] = [];
  let wrongOwner = false;
  const client = new OpenPondTasksetPackageClient({ baseUrl: "https://api.example.test", apiKey: "test-key", teamId: "team-a", fetch: async (url, options) => {
    requests.push({ url: String(url), body: options?.body as string | undefined, team: new Headers(options?.headers).get("X-OpenPond-Team-Id"), redirect: options?.redirect });
    const owner = { teamId: wrongOwner ? "team-b" : "team-a", modelProjectId: "model-a" };
    return Response.json(options?.method === "POST" ? { schemaVersion: "openpond.tasksetPackageReceipt.v1", ...owner, operationId: "publication-a", taskset: ref, packageHash: packageValue.contentHash, hostedTasksetId: "hosted-taskset", projectEtag: "a".repeat(64) } : { schemaVersion: "openpond.tasksetPackageReadback.v1", ...owner, package: packageValue });
  } });
  const publication: TasksetPackagePublication = { schemaVersion: "openpond.tasksetPackagePublication.v1", operationId: "publication-a", modelProjectId: "model-a", expectedProjectEtag: null, name: "Work tasks", description: "", buildIntent: "verifiable_reward", methodHint: null, package: packageValue };
  expect((await client.publish(publication)).packageHash).toBe(packageValue.contentHash);
  await client.publish(publication);
  expect(requests[0]!.body).toBe(requests[1]!.body);
  expect(await client.get("model-a", ref)).toEqual(packageValue);
  expect(requests.every(request => request.team === "team-a" && request.redirect === "error")).toBe(true);
  expect(requests[2]!.url).toBe(`https://api.example.test/v1/taskset-packages/model-a/${ref.id}/${ref.revision}/${ref.contentHash}`);
  wrongOwner = true;
  await expect(client.publish(publication)).rejects.toMatchObject({ code: "package_receipt_mismatch" });
  await expect(client.get("model-a", ref)).rejects.toMatchObject({ code: "package_readback_mismatch" });
  wrongOwner = false;
  await expect(client.get("model-a", { ...ref, revision: 2 })).rejects.toMatchObject({ code: "package_readback_mismatch" });
  expect(await client.get("model-a", ref, { expectedPackageHash: packageValue.contentHash })).toEqual(packageValue);
  await expect(client.get("model-a", ref, { expectedPackageHash: "0".repeat(64) })).rejects.toMatchObject({ code: "package_readback_mismatch" });
  const count = requests.length;
  await expect(client.get("model-a", ref, { expectedPackageHash: "invalid" })).rejects.toThrow();
  expect(requests).toHaveLength(count);
});
