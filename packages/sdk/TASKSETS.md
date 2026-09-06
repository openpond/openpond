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
