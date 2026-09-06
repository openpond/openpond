# Model starter contracts

SDK 0.1.7 adds `openpond-sdk/model-starters` and `openpond-sdk/model-starter-catalog`.

A starter pins a Taskset, task definition, Reward binding, Reward releases and text assets by identity, revision and content hash. `validateResolvedModelStarter` checks the complete small-package graph, executable grader equivalence, task schemas, split isolation and preview selection. Reward source stays private to evaluation. Resolved small packages are limited to 16 MiB; large Tasksets require the manifest/shard path rather than increasing this limit.

`OpenPondModelStarterCatalogClient` lists metadata with `list({ limit, afterId })` and retrieves an exact package with `resolve({ id, revision, contentHash })`. It authenticates requests with an API key and workspace, rejects redirects, bounds streamed responses and checks returned identities. The hosted catalog endpoint must be deployed before these methods can be used against an environment.

`previewModelStarter(package)` projects only selected non-frozen inputs and policy-visible context, format schemas, metadata and split counts. It excludes expected outputs, private context and verifier bytes. Selection and preview perform no creation operation.

`createModelStarterCreationRequest(intent)` prepares the final configuration:

```ts
import { createModelStarterCreationRequest } from "openpond-sdk/model-starters";

const request = await createModelStarterCreationRequest({
  profileId,
  modelId,
  name: "Invoice extractor",
  starter: { id: starter.id, revision: starter.revision, contentHash: starter.contentHash },
  startingModel: starter.startingModel,
  method: starter.defaultMethod,
});
```

Prepare the request on final confirmation and retain it for transport retries. The server must authorize the profile, resolve trusted catalog content, materialize immutable files and atomically save resources, model configuration and the original retry receipt. A stable operation ID alone does not implement server idempotency. Creation starts no model call or training job.

Evidence references are nullable pointers to actual verifier, baseline, training and evaluation results. Publication and package integrity do not qualify a starter or imply improvement. Continuous learning is a separate model workflow mode; it is not a starter category or comparison-run type.

The repository's invoice-extraction example authors 80 original synthetic text tasks and executes its verifier fixtures. Its baseline, training, evaluation and full product qualification remain pending. The local server includes preparation, atomic persistence and file-materialization adapters; catalog publication, route wiring and Desktop Get Started integration are separate delivery steps.
