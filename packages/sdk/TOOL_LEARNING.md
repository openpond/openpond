# Tool learning

`openpond-sdk/tool-learning` exports the bounded event/consultation contracts and `OpenPondToolLearningClient`. Native OpenPond and Claude Code share the same local capture, queue, delivery, and consultation implementation. Tool learning is a separate opt-in from conversation imports. It captures permitted tool arguments and result excerpts, rather than whole conversations.

Use `openpond tool-learning --help` for setup and lifecycle operations. `setup` requires the selected workspace, an existing private Model, the exact permitted tool names, a bounded application/version context file, and `--allow-upload`. It reuses the existing OpenPond home/account. Claude hooks and its local stdio MCP server receive an installation credential; they do not receive the owner's account key. Native support uses the bundled harness. Restart the client and run `doctor` to check actual lifecycle observations, pending evidence, and MCP tool discovery.

```ts
import { OpenPondToolLearningClient } from "openpond-sdk/tool-learning";

const owner = new OpenPondToolLearningClient({
  baseUrl: apiOrigin,
  apiKey: ownerApiKey,
  teamId,
  projectId: modelId,
});
```

Prepare registration with `prepareToolLearningRegistration`, then **privately retain its exact request and prepared secret before calling `register`**. Retrying those same bytes recovers credential issuance. Store the installation credential in the existing encrypted OpenPond home; never put it in agent instructions, client settings, logs, source control, or browser code.

The owner can list/read private episodes, select a failed observation and later successful observation with `project`, change installation state, purge raw events, and configure routing. A producer credential can append only to its installation and read/submit its consultation configuration/results. It cannot read raw episodes, list other installations, project evidence, train, activate a model, or call unrelated APIs.

`append` verifies receipt scope, event IDs/hashes, and the exact request hash. A receipt acknowledges retention or privacy rejection; it does not approve an example for training. Reuse the operation ID and exact payload after an uncertain response. Changed bytes conflict. Evidence delivery never retries the user's tool execution.

`project` verifies authenticated retained attempt/observation lineage and creates a private **pending owner review** target. The recovered action and observation stay privileged review evidence. The owner separately reviews and seals a supervised batch through the existing learning API. The installation itself grants no training authority, GPU allocation, or model update. Internal SFT uses the existing training protocol and reviewed packages; it does not require a new external Python SDK.

`configureRouting` selects a model, completed evaluation receipts, declared application/version/tool capabilities, and explicit call/session/day limits. Integration qualification identifies unchanged weights and their gateway configuration. Learned qualification additionally binds a completed SFT run, held-out comparison, and the matching served adapter. A capability manifest advertises only the current qualified selection. It contains routing guidance, not a list of corrections or training answers.

Consultation consumes an actual retained failure, checks exact action/context/model pins, uses the normal metered gateway, and returns typed `proceed`, `revise`, or `needs_context` advice. Operational failures return unavailable; they never become `proceed`. The original agent retains execution, permissions, cancellation, and outcome verification. After acknowledgement loss, recover the original operation with `consultation`; do not create another paid request. A changed model or context does not authorize an extra round for the same failed call.

`openpond-sdk/tool-learning/node` contains `ToolLearningLocalStore`. It requires Node's SQLite support and is never imported into browser bundles. The local store bounds pending events, short-lived cross-process correlation, and consultation recovery requests together. Ordinary successful controls are sampled; after failure, a bounded ten-minute/32-observation follow-up window retains possible recoveries for explicit review. This does not infer a verified recovery. Privacy/capacity omissions and expired events remain visible in local status.

Disable/revoke stops new capture/consultation admission. Uninstall revokes the credential and removes only owned configuration. Raw-event purge and expiry do not erase reviewed Dataset releases or changes already incorporated into model weights. Those have separate retention and lineage.
