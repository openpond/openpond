# Published Taskset inventory

`openpond-sdk/taskset-catalog` provides authenticated, paginated metadata reads
for the selected hosted workspace. The service applies workspace access and
optional Model Project attachment filtering before returning records.

```ts
import { OpenPondTasksetCatalogClient } from "openpond-sdk/taskset-catalog";

const tasksets = new OpenPondTasksetCatalogClient({
  baseUrl: "https://api.openpond.ai",
  apiKey,
  teamId,
});
const page = await tasksets.list({ limit: 30, modelProjectId });
const item = await tasksets.get(page.items[0].id);
const selected = await tasksets.resolve(item.release);
const next = page.nextCursor
  ? await tasksets.list({ limit: 30, modelProjectId, afterId: page.nextCursor })
  : null;
```

The item's `id` is the hosted inventory identity. Its `release` pins the portable
ID, revision and content hash used in model configuration. Metadata reads contain
no task rows, private verifier source or object-store locations. Publication and
package byte counts do not establish grading or training readiness.

The client rejects responses for a different workspace or requested resource,
limits catalog responses to 4 MiB, supports abort signals, and does not follow
redirects with credentials. `OpenPondTasksetCatalogError` preserves HTTP status and
the service's error code.

## Complete private packages

`openpond-sdk/taskset-packages` exports `createTasksetPackage`,
`validateTasksetPackage`, `decodeTasksetPackageFile`, and
`OpenPondTasksetPackageClient`. A package carries the exact Taskset, Environment
and Verifier Set releases, binary files encoded as canonical base64, and the
complete model resource graph when the Taskset declares a model binding.

Validation verifies release hashes, dependency references, file bytes and
visibility. The package content hash seals the whole graph, including files
outside the Taskset manifest. The 64 MiB limit includes the JSON envelope and
base64 encoding. Validation does not establish execution readiness or authorize
access to private resources.

The client defines authenticated `POST /v1/taskset-packages` publication and
`GET /v1/taskset-packages/{model}/{taskset}/{revision}/{hash}` readback. These
operations require a host that implements the package protocol; availability
must be verified before enabling a hosted transfer flow.

Callers retain the publication's operation ID and expected project ETag across
retries. A successful receipt binds the operation, workspace, Model, Taskset
release, complete package hash and resulting project ETag. Pass its `packageHash`
as `get`'s `expectedPackageHash` to pin readback to that publication. The client
checks response ownership and release identity, rejects credential redirects,
and bounds streamed response bytes. Hosts must authorize Model access, enforce
immutable release-to-package mappings, and commit attachment and operation
receipts atomically with the project revision check.
