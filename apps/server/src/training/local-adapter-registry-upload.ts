import { z } from "zod";
import type { RegisteredAdapterAttach } from "openpond-sdk/model-projects";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const fileDescriptor = z.object({ path: z.string(), mediaType: z.string(), sha256: hash, sizeBytes: z.number().int().positive() });
const uploadSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,191}$/), state: z.enum(["created", "uploading", "committing", "committed"]),
  version: z.number().int().positive(), source: z.literal("direct_upload"), internal: z.literal(false), baseProfileId: z.string(),
  artifactId: z.string().nullable(), files: z.array(fileDescriptor).length(2) });
const planSchema = z.object({ upload: uploadSchema, uploadCapabilities: z.array(z.object({ path: z.string(), url: z.url(), headers: z.record(z.string(), z.string()) })).max(2) });
const completionSchema = z.object({ upload: uploadSchema, artifact: z.object({ id: z.string(), teamId: z.string(), ownerUserId: z.string(),
  baseProfileId: z.string(), source: z.literal("direct_upload"), internal: z.literal(false), contentHash: hash, files: z.array(fileDescriptor).length(2) }) });
type UploadFile = { path: string; mediaType: string; sha256: string; bytes: Uint8Array<ArrayBuffer> };

export async function uploadLocalAdapterToRegistry(input: {
  apiBaseUrl: string; teamId: string; actorId: string; baseProfileId: string; label: string; idempotencyKey: string;
  files: UploadFile[]; hostedFetch: typeof fetch; fetch: typeof fetch; verifyScope(): Promise<unknown>; signal: AbortSignal;
}): Promise<RegisteredAdapterAttach["artifact"]> {
  const descriptors = input.files.map(({ bytes, ...file }) => ({ ...file, sizeBytes: bytes.byteLength }));
  function matches(files: (typeof descriptors)) {
    return files.length === descriptors.length && descriptors.every(expected => files.some(file =>
      file.path === expected.path && file.sha256 === expected.sha256 && file.sizeBytes === expected.sizeBytes && file.mediaType === expected.mediaType));
  }
  async function post(route: string, body: unknown) {
    const response = await input.hostedFetch(`${input.apiBaseUrl.replace(/\/$/, "")}/v1/model-adapters/uploads${route}`, {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", accept: "application/json" },
    });
    if (!response.ok) throw new Error(`The adapter registry could not save the upload (${response.status}).`);
    return response.json() as Promise<unknown>;
  }
  const plan = planSchema.parse(await post("", { teamId: input.teamId, label: input.label, baseProfileId: input.baseProfileId,
    idempotencyKey: input.idempotencyKey, files: descriptors }));
  const upload = plan.upload;
  if (upload.baseProfileId !== input.baseProfileId || !matches(upload.files)) throw new Error("The registry upload plan differs from the reviewed adapter.");
  if (upload.state === "created" || upload.state === "uploading") {
    const targets = input.files.map(file => {
      const matching = plan.uploadCapabilities.filter(item => item.path === file.path);
      if (plan.uploadCapabilities.length !== input.files.length || matching.length !== 1)
        throw new Error("The registry did not authorize both exact adapter files.");
      const capability = matching[0]!;
      const url = new URL(capability.url);
      const headers = new Headers(capability.headers);
      const expected = {
        "content-type": file.mediaType,
        "x-amz-checksum-sha256": Buffer.from(file.sha256, "hex").toString("base64"),
        "x-amz-meta-openpond-sha256": file.sha256,
        "x-amz-meta-openpond-upload-id": upload.id,
        "x-amz-meta-openpond-team-id": input.teamId,
      };
      const signed = new Set(url.searchParams.get("X-Amz-SignedHeaders")?.split(";"));
      if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        url.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" || !hash.safeParse(url.searchParams.get("X-Amz-Signature")).success ||
        [...headers.keys()].length !== Object.keys(expected).length ||
        !signed.has("host") || !signed.has("content-length") ||
        !Object.entries(expected).every(([name, value]) => headers.get(name) === value && (name === "content-type" || signed.has(name))))
        throw new Error("The registry returned an upload capability that does not match the reviewed file.");
      return { url, headers, bytes: file.bytes };
    });
    for (const target of targets) {
      await input.verifyScope();
      const result = await input.fetch(target.url, { method: "PUT", body: target.bytes, headers: target.headers,
        redirect: "error", credentials: "omit", signal: input.signal });
      if (!result.ok) throw new Error(`The signed registry upload failed (${result.status}). Reopen the review to retry.`);
    }
  } else if (plan.uploadCapabilities.length) throw new Error("A completed upload returned unexpected storage capabilities.");

  const done = completionSchema.parse(await post(`/${encodeURIComponent(upload.id)}/complete`, { expectedVersion: upload.version }));
  const { artifact } = done;
  if (done.upload.id !== upload.id || done.upload.state !== "committed" || done.upload.artifactId !== artifact.id ||
    done.upload.baseProfileId !== input.baseProfileId || !matches(done.upload.files) ||
    artifact.teamId !== input.teamId || artifact.ownerUserId !== input.actorId || artifact.baseProfileId !== input.baseProfileId || !matches(artifact.files))
    throw new Error("The committed registry artifact differs from this Model's reviewed adapter.");
  return { id: artifact.id, contentHash: artifact.contentHash, baseProfileId: artifact.baseProfileId,
    configSha256: descriptors.find(file => file.path === "adapter_config.json")!.sha256,
    weightsSha256: descriptors.find(file => file.path === "adapter_model.safetensors")!.sha256 };
}
