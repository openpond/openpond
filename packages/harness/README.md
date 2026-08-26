# `@openpond/harness`

Public provider-neutral learning operations, portable contracts, and pure
helpers for OpenPond's mutable Harness:

- immutable Agent snapshots and Harness releases;
- content-addressed assets, artifacts, releases, and hashes;
- tool declarations and model identities;
- Harness workspaces, pinned run overlays, proposals, validation, advancement,
  rollback, and merge receipts;
- improvement observations, Refiner outcomes, and apply receipts;
- versioned Refiner evidence-basis decisions and display-safe Work receipts;
- a public provider-neutral model-driven Refiner plus optional managed-host request/response contracts;
- model-driven continuous review over bounded authorized evidence, with exact
  source-policy, claim, routing, authority, and downstream lineage receipts;
- bounded cross-run candidates, lifecycle receipts, and continuation identities;
- model actions, tool observations, lifecycle events, and Harness traces.

## Install

```bash
npm install @openpond/harness
```

Node.js 22.14 or newer is required. `@openpond/harness` depends only on Zod; it
does not install or invoke `openpond-sdk`, `openpond-agent-sdk`, an OpenPond
server, or a model-provider SDK.

```ts
import {
  HarnessReleaseSchema,
  HarnessEvaluationReviewReceiptSchema,
  HarnessRefinementCandidateSchema,
  HarnessRefinerActivityReceiptSchema,
  HarnessRunOverlaySchema,
  ImprovementObservationSchema,
  contentHash,
} from "@openpond/harness";
```

Subpath exports are available at `/harness`, `/evaluation-review`, `/refiner`,
`/harness-improvements`, `/harness-workspaces`, `/refinement-lifecycle`,
`/models`, and `/tools`.

This package does not run evaluations, grade outputs, persist product state,
execute a desktop or hosted session, resolve credentials, schedule jobs, or
launch training. Hosts provide model streams and authorized evidence; the
package owns the shared Refiner and continuous-review policy. Evaluation
Tasksets, runners, receipts, graders, and Work-evidence eligibility live in
`@openpond/evals`, which depends on this package.

Semantic decisions are model-driven. Deterministic helpers enforce schema,
identity, bounds, safe targets, and receipt invariants; they do not assign a
route from prompt keywords, error strings, tool names, or a fixed recurrence
count.

## How the standalone Refiner works

The Refiner is more than a reusable prompt, but less than an autonomous Agent.
It is a provider-neutral policy engine around a model stream and a bounded
evidence contract:

```text
host Agent/runtime
  -> bounded evidence + current mutable sources
  -> @openpond/harness Refiner
  -> no action | external route | exact edit proposal
  -> host review, validation, application, and release
```

### Extend the Refiner with a Review Profile

The Refiner definition is versioned separately from the Harness it reviews. A
turn pins a Harness release and a Refiner release. The Refiner may propose the
next Harness release, but it never edits its own active definition during that
review.

The portable managed source is JSON:

```json
{
  "schemaVersion": "openpond.refinerReviewProfile.v1",
  "id": "acme.review",
  "version": "1",
  "name": "Acme review",
  "objective": "Find the smallest reusable correction supported by the trace.",
  "instructions": [
    {
      "id": "pdf-completion",
      "text": "Treat a failure that prevents reading a requested PDF as material review evidence."
    }
  ],
  "allowedProposalRoutes": ["memory", "prompt", "skill", "agent"],
  "allowedExternalRoutes": ["runtime", "product", "taskset", "training"]
}
```

Use `defineReviewProfile` as an optional TypeScript authoring helper, then pass
the profile to `authorLocalHarnessRefinementWithModel`. The same contracts are
also re-exported from `openpond-sdk/refiner`.

```ts
import {
  authorLocalHarnessRefinementWithModel,
  defineReviewProfile,
} from "@openpond/harness/refiner";

const reviewProfile = defineReviewProfile(profileJson);
const decision = await authorLocalHarnessRefinementWithModel({
  evidence,
  stream,
  signal,
  reviewProfile,
});
```

`openpond app-server --store-dir <dir>` adds host-owned persistence beside the
Harness store under `<dir>/refiners`. Its JSON-RPC surface exposes
`refiner/inspect`, `refiner/update`, `refiner/activate`, and `refiner/rollback`.
The bundled `openpond-refiner-authoring` Skill uses those operations from a
normal Work turn; `/refiner <change>` is the explicit authoring route. Core
evidence, privacy, ownership, validation, and activation boundaries cannot be
relaxed by a Review Profile.

1. The host supplies the completed-turn evidence, admitted and current Harness
   source, available mutation capabilities, and the exact evidence IDs the
   model may cite.
2. The package validates and bounds that input, constructs the Refiner messages,
   requests a structured decision from the host's model stream, and repairs one
   malformed response when necessary.
3. Proposed mutations and recovery-related `no_action` decisions receive an
   additional independent model critique.
4. Deterministic admission rejects invented evidence IDs and proposals aimed at
   unavailable memory, prompt, Skill, or Agent layers. Invalid final proposals
   fail closed to `no_action`.
5. The host decides whether and how to persist, review, validate, apply, advance,
   or roll back an admitted proposal.

The host therefore brings its own conversation history, traces, artifacts,
memory, instructions, Skills, Agent definitions, persistence, authorization,
and model adapter. Those inputs do not have to use OpenPond's file layout or
Agent SDK internally, but they must be projected into
`LocalHarnessRefinerEvidence`. `openpond-agent-sdk` is an optional downstream
authoring/runtime choice for a host that wants Refiner proposals to update an
OpenPond Agent project; the Refiner never imports it or calls it under the hood.

### Decision surface

The Refiner returns one of three outcomes:

| Outcome | Meaning | Host responsibility |
| --- | --- | --- |
| `no_action` | The supplied evidence does not justify a durable change. | Record or discard the outcome according to host policy. |
| `route` | The issue belongs to `runtime`, `product`, `taskset`, or `training`, not a mutable Harness source. | Send it to that workflow. A `taskset` route suggests evaluation coverage; it does not author or run a Taskset. |
| `propose` | The evidence supports one exact `create`, `update`, or `delete` operation in `memory`, `prompt`, `skill`, or `agent`. | Review, apply, validate, version, and roll back the change when necessary. |

The package proposes edits but never performs them. For an update it returns an
exact `target`, `find`, and `replace`; for a creation it returns `target` and
`createContent`. The host maps those logical paths to its own Markdown files,
database records, JSON configuration, or framework-specific source format.
Hosts that use OpenPond Agent SDK source can apply the same proposal through
their Agent-project workflow, but matching the Agent SDK format is not required.

### Provider adapter

Connect any provider by adapting it to `LocalHarnessRefinerModelStream`:

```ts
import {
  authorLocalHarnessRefinementWithModel,
  type LocalHarnessRefinerEvidence,
  type LocalHarnessRefinerModelStream,
} from "@openpond/harness/refiner";

const stream: LocalHarnessRefinerModelStream = async function* ({
  messages,
  signal,
}) {
  const response = await yourModel.generate({ messages, signal });
  yield { text: response.text };
};

const evidence: LocalHarnessRefinerEvidence = {
  capabilities: { memory: true, prompt: true, skill: true, agent: false },
  trigger: { decision: "queue_refiner" },
  observations,
  admissibleEvidenceIds: observations.map((item) => item.id),
  reviewPacket,
  runtimeActivation: {
    admittedRelease,
    currentRelease,
    rebasedOntoCurrent: false,
    admittedSourceFiles,
    admittedSourceCatalog,
  },
  sourceFiles,
  sourceCatalog,
  additionalEvidence: null,
};

const decision = await authorLocalHarnessRefinementWithModel({
  evidence,
  stream,
  signal: new AbortController().signal,
});

if (decision.decision === "propose") {
  // Present and validate the exact edit before your host applies it.
  console.log(decision.route, decision.target, decision.summary);
}
```

`reviewPacket` is the bounded chronological incident record: the current turn,
up to three prior conversation turns, timeline events, artifacts, diagnostics,
execution counters, matching prior incidents, and truncation metadata.
`sourceFiles` contains only source content the Refiner is authorized to inspect;
`sourceCatalog` can list additional known targets without exposing their
contents. Never place secrets, credentials, or unrelated private conversations
in either structure.

The returned value is only `no_action`, an external ownership route, or an exact
Harness edit proposal. Calling the function never writes a file or mutates host
state. Use the workspace, proposal, validation, advancement, merge, and receipt
helpers from this package if their immutable state model fits your host; storage
and side effects remain yours.

The fast Refiner reviews one completed turn. Proposed edits receive a second
model critique before they can reach host validation, so task-specific content
can be generalized, routed, or rejected. Continuous review navigates large
authorized windows from compact previews, then inspects a bounded set of full
payloads. Evidence outside that full-review bound is deferred rather than
silently consumed. Neither operation launches training or activates a Model.

Hosts should keep continuous review opt-in. OpenPond defaults new Harness
workspaces to manual review with activity-triggered review disabled; enabling a
schedule or activity batch is an explicit host/user decision.

For a Harness-maintenance finding, the continuous reviewer explicitly chooses
whether to `observe` the candidate for more evidence or `confirm` that it is
actionable now. Independent occurrence count is evidence for that semantic
decision, not a hard promotion threshold. External runtime, product, and
Taskset classifications do not create refinement candidates.

Runtime authoring uses `openpond.localHarnessRefinerDecision.v2`. Every route
or proposal names a `single_deterministic` or `recurrent_independent` evidence
basis, and the package rejects references that are not present in the bounded
packet. Proposal routes are also checked against the request's advertised
memory, prompt, Skill, and Agent capabilities. The v1 decision schema remains
exported for explicit compatibility reads; it is not the runtime authoring
contract.

## Verification

```bash
pnpm --dir packages/harness run check
```

The check typechecks, tests, builds, scans the public dependency boundary,
installs the packed tarball into a clean consumer, verifies runtime and
TypeScript imports, and dry-run packs the public artifact.
