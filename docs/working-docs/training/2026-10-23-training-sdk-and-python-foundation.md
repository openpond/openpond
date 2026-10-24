# Training SDK and Python foundation

Status: implementation authorized and in progress for foundation Phases 1–3, including the prerequisite Phase 0 inventory. Existing platform security fixes and deployed acceptance remain gates before the full end-to-end GPU run. Deeper trainer control and new training methods stay deferred.

Latest checkpoint: 2026-10-24 11:20Z. The owner’s sequence remains security qualification → SDK foundation Phases 1–3 → the full GPU campaign. SDK/Ponder0.12.8 and Python0.1.0 source cover69 operations (68 hosted paths; estimates remain unsupported). The TypeScript real HTTP stream/media boundary passes. Python's two HTTP/wire boundaries and all four exact-wheel pip/uv consumers on Python3.10/3.14 pass. Source review caught duplicated generated schema output; lossless structural interning reduces each schema asset from16.6MB to675KB, with full expanded serialization and all530 model modules unchanged. Root and peer reviews verify573 Python file bindings and exact final artifacts. The combined source PR is ready for exact-tree CI without unrelated Desktop work. New publication, fresh TypeScript artifact consumers, registry ownership and deployed workflows remain open. Sandbox654675 is staged/checkpointed; eight public secret rejection checks and exact synthetic cleanup pass. CPU6cec is installed/verified; the OCI fixture must be corrected for its actual chroot execution before a fresh canary. Security findings remain open.

Execution order: SEC-01 ownership enforcement and synthetic tenant-boundary proof → SEC-02 confined import and isolated multilayer/sentinel/cleanup proof → complete foundation Phases 1–3, including versioned distribution and deployed workflow acceptance → admit the separately bounded full GPU campaign. Preserve existing platform/runtime gates and spending limits. Source work, package verification, publication, staging deployment and actual model execution must be reported separately.

Related docs:

- [Training launch product review](../../../../sandbox/docs/working-docs/deployment/2026-10-23-training-launch-product-review.md) — broader competitive direction and deferred scale decisions; this focused document owns SDK delivery sequencing.
- [Production training readiness and elastic capacity](../../../../sandbox/docs/working-docs/deployment/2026-10-22-production-training-readiness-and-elastic-capacity.md) — existing hosted platform qualification; this plan does not change its gates or live evidence.
- [Training protocol](../../../packages/sdk/TRAINING_PROTOCOL.md) and [Learning API guide](../../../packages/sdk/LEARNING.md) — current contracts, identities, approvals and host responsibilities.
- [Server SDK packaging and release](../cli/2026-07-31-server-sdk-package-and-release.md) — historical packaging design; inspect current scripts and package manifests before choosing release commands.

## Summary

The first deliverable is a complete developer-facing SDK path for the training product we already have. Extend the public TypeScript SDK where existing product operations lack supported access, and add a maintained Python package against the same API contracts. A user should be able to prepare and launch an existing supported training job, inspect results and evaluation, recover or cancel through existing controls, and use the existing evidence/feedback/continual workflow without the Desktop UI.

The TypeScript SDK already exposes much of this. This work must start with an inventory, not a second SDK architecture or a replacement training system. Python needs a usable complete workflow, not just HTTP snippets, and TypeScript should remain equally capable. The initial scope is training and its data, reward, harness, evaluation and learning dependencies; porting unrelated sandbox, commerce or chat APIs is not a prerequisite.

Longer-term competitive training control remains the direction. However, low-level sessions, arbitrary batches/advantages, custom gradients, new losses, SFT and DPO must not inflate the initial delivery. Existing job-level train/evaluate/reconfigure/retrain loops are already useful programmable workflows.

## Current Code Review

| Surface | Current source and implication |
| --- | --- |
| Public TypeScript package | [SDK exports](../../../packages/sdk/package.json) publish training, model-project, dataset, learning and evaluation entrypoints. Extend these; the separately named [training-sdk package](../../../packages/training-sdk/package.json) is private internal code. |
| Training jobs | [Training client](../../../packages/sdk/src/training.ts#L713) provides capabilities, GPU catalog, staging, submission, job reads, cancellation, stop-after-group, checkpoint recovery, events/logs, outputs and retained evaluation tasks. These are existing controls to expose consistently in Python. |
| Preparation and model configuration | [Preparation client](../../../packages/sdk/src/training-preparations.ts#L111), [Model Projects client](../../../packages/sdk/src/model-projects.ts#L394) and [managed submission builder](../../../packages/sdk/src/managed-training-preparation.ts) cover reviewed configuration, pinned inputs and immutable submission. Inventory local/hosted route availability rather than treating a schema as deployed support. |
| Learning and continual workflows | [Learning client](../../../packages/sdk/src/learning-client.ts#L38), [commands](../../../packages/evals/src/learning/operations.ts) and [policy helper](../../../packages/sdk/src/model-learning-policy.ts) provide evidence/feedback, review, batches, policies and iteration control. The current hosted policy helper requires GRPO. |
| Data, Rewards and Harnesses | [Dataset workspace exports](../../../packages/sdk/src/dataset-workspaces.ts), [Rewards](../../../packages/evals/src/rewards.ts), [Harness source client](../../../packages/sdk/src/training-harness-sources.ts) and [bundle exports](../../../packages/sdk/src/training-bundle.ts) supply reusable inputs. Preserve immutable assets, hashes and private grader boundaries. |
| Evaluation and review | [Model Taskset runs](../../../packages/sdk/src/model-taskset-runs.ts), [post-training client](../../../packages/sdk/src/post-training.ts#L226), [acceptance reads](../../../packages/sdk/src/training-acceptance.ts#L30) and [candidate decisions](../../../packages/sdk/src/training-candidate-decisions.ts) cover evaluation and retained review. Acceptance and serving remain separate operations. |
| Python starting point | [Python intake example](../../../packages/sdk/examples/learning/submit.py) demonstrates source-scoped evidence submission; it is not a maintained Python SDK for the training workflow. |
| Existing executable methods | [Hosted capabilities](../../../../sandbox/deployment-worker/domain/services/managed-rl/training-v2-capabilities.ts#L18) advertise GRPO and reward-model training. SFT/DPO/PPO recipe definitions do not establish hosted execution. Preserve the current supported model/runtime envelope. |
| Deeper trainer operations | [Managed signal boundary](../../../apps/server/src/training/openpond-managed-training-adapter.ts#L604) consumes the immutable submission; [resident trainer](../../../../sandbox/managed-rl-worker/policy_trainer.py#L1448) is internal. Exposing per-update control is a later API/runtime feature, not a Python binding task. |

Source inspection establishes implementation shape, not deployed qualification. Concurrent source work may change these anchors; refresh the inventory before implementation.

Python final local qualification is `tmp/python-sdk-foundation-20261024/local-qualification.interned.json` (SHA256 `f3a13ec220729f2b4bbd3f52b6e889df027f49d638bc39fd6d6ca513f1cb8b46`); root independently verified all573 source/receipt bindings, full expanded serialization and both artifact hashes. The lossless-storage successor passed the existing two boundary cases in1.64s and four fresh pip/uv consumers. Earlier expanded/formatting artifact cohorts remain historical evidence. This is local package evidence, with no registry or hosted execution claim.

Current foundation evidence: [source-backed operation matrix](../../../packages/sdk/fixtures/python-foundation/operation-matrix.json), [TypeScript workflow/lifecycle guide](../../../packages/sdk/TRAINING_WORKFLOWS.md), [Ponder distribution](../../../packages/ponder-sdk/README.md), and [Python package](../../../python/openpond-sdk/README.md). The reviewed TS remote-base candidate is `tmp/sdk-foundation-ts-20261024/remote-0128-v8/` (independent source/delta reviews, real HTTP stream/media proof, and membership in the existing Python CI lanes); the packed wrapper's32-subpath runtime identity check against existing registry0.12.6 is **mechanism proof only**, not qualification of new0.12.8 source. Current local package manifests are stale development work; the release candidate preserves current upstream dependency floors without overwriting unrelated desktop work.

Portable identity boundary: training's compact canonical JSON and content hashes have shared cross-language vectors. Some Harness/Learning/Dataset authoring hashes use pretty JSON with locale-based key ordering; Python must not substitute the compact algorithm. The ordinary hosted reviewed-batch workflow uses existing sealed resources and immutable references, without local custom Reward/Harness authoring or Node execution. Record the exact accepted-artifact and independently verified-hash boundaries in the Python capability guide; do not describe those authoring formats as independently rehashed until they are actually qualified.

## Product Decision

Deliver the base in Phases 0–3. A caller uses the existing managed training algorithms and configures the currently supported data, rewards, harness, recipe, continuation and budget. The SDK controls job preparation/execution and the surrounding evaluation/continual workflow. It does not claim individual gradient-step control at this stage.

Python is a first-class client: typed requests/results, synchronous and asynchronous usage, explicit lifecycle/timeouts, structured errors, pagination and safe retry/reconciliation. It uses the same authentication, scope, content hashes and approval semantics as TypeScript. Do not port server domain rules or database logic to Python.

Keep its source in the OpenPond repository under `python/openpond-sdk/`, following the existing `python/openpond-datasets/` layout: `pyproject.toml`, `src/`, examples/documentation and a development `uv.lock`. Use `uv` for dependency/environment management, development commands and building wheel/source distributions. Distribute versioned releases through PyPI; customers can install with either `pip install <distribution-name>` or `uv add <distribution-name>` and do not need Node or uv merely to use the installed SDK. The candidate distribution/import names are selected below; registry ownership remains unverified, and the source directory does not reserve a PyPI name. Follow the official [uv packaging guide](https://docs.astral.sh/uv/guides/package/) and [Python packaging guide](https://packaging.python.org/en/latest/tutorials/packaging-projects/). This is package distribution, separate from deferred distributed GPU training.

Selected candidate names: Python distribution `ponder-sdk`, import package `ponder_sdk`; the repository source folder can retain the path above because the distribution name is independent. Also publish an npm `ponder-sdk` entry to the complete existing TypeScript SDK, while retaining `openpond-sdk`. Prefer a small package with generated JavaScript/type re-exports for every supported entrypoint, depending on the exact matching `openpond-sdk` version. Use one implementation, preserve subpaths such as `ponder-sdk/training` and `ponder-sdk/learning`, and coordinate release/consumer checks. Do not fork SDK code or perform a repository-wide rename. A customer-local npm alias is distinct from publishing a discoverable `ponder-sdk` registry package.

The npm Ponder package should expose the current TypeScript SDK surface; the initial Python package still follows this document's training/evaluation/learning scope. Shared branding must not imply that unrelated TypeScript APIs have already been ported to Python. Direct public metadata checks at 22:59Z on October 23 returned 404 from `https://registry.npmjs.org/ponder-sdk` and `https://pypi.org/pypi/ponder-sdk/json`. This records no current public entry, not a reservation or guarantee that either registry will accept the name.

The base must be usable without requiring a Node subprocess for ordinary hosted preparation of a reviewed batch. Reuse existing hosted compilation/preparation. For advanced artifact submission, accept the existing portable format and implement only necessary portable validation/serialization; do not quietly port every TypeScript authoring/runtime package. Python-authored custom environment or Reward execution is a separate later bridge. Initial Python code can orchestrate published resources and submit evidence through existing APIs.

Keep SFT and DPO as explicit later implementation phases, each with its own runnable algorithm and acceptance. Do not advertise them because model configuration enums already contain the names. Distillation, broader loss catalogs, full-parameter mode, larger models and distributed infrastructure remain separate follow-up scope.

## Implementation Shape

| Owner | Base delivery | Later capability work |
| --- | --- | --- |
| OpenPond OSS | Inventory/complete current TypeScript training surface, shared portable contracts, Python package, examples and consumer validation. | Extend clients when new training operations/methods become executable. |
| Sandbox public API | Verify existing routes support external authenticated clients; add only verified gaps needed to expose existing behavior. Preserve team authorization, revisions, idempotency, budgets and bounded responses. | Session/gradient/checkpoint APIs or new method admission where separately implemented. |
| Deployment worker and GPU runtime | Reuse current GRPO/reward-model execution and lifecycle. Change only a verified defect blocking the base workflow, not a speculative trainer rewrite. | Implement per-update control, new objectives and SFT/DPO execution in later phases. |
| Evals/Harness packages | Reuse released tasks, graders, Rewards, environments, rollout evidence and evaluation contracts. | Add Python authoring adapters only if subsequently selected; retain one grading/evaluation authority. |

Phase 0 produces a bounded operation matrix with columns for product action, TypeScript export, public route/media type, local/hosted availability, Python method, authorization and proof. Classify each row as existing client, existing endpoint needing a client, verified missing product-access endpoint, or genuinely new backend feature. The last category is later scope unless it prevents an already-supported product workflow.

Use a common schema/fixture source for portable wire contracts. Preserve schema-defined defaults, omitted versus null fields, canonical JSON and hash behavior, including Unicode and numeric serialization. Identical cross-language requests must retain identical identities. Avoid maintaining independent hand-translated algorithm rules. The generated-versus-handwritten model boundary can be chosen during Phase 0.

A representative base workflow is: inspect capabilities/configuration → select or publish existing-format data/Reward/Harness resources → review/seal a batch → prepare and explicitly start an existing supported job → observe/reconnect → read outputs and evaluation → explicitly record a candidate decision. A second example covers evidence/feedback and existing continual policy/iteration controls. Recovery/cancellation use existing operations. Any supported serving controls included in the matrix remain explicit and separate from candidate acceptance.

## Boundaries

- The October 24 owner instruction authorizes implementation and completion of foundation Phases 1–3, with prerequisite inventory, after SEC-01/SEC-02 remediation and before the full end-to-end GPU run. Independent SDK source work may proceed in parallel. Use the existing approved release flow and verify publisher ownership before publication; retain explicit finite admission bounds for any actual training. Later phases are not authorized by this extension.
- Phases 0–3 must not acquire a dependency on a new trainer session protocol, custom gradient API, new algorithm, larger model, binary dataset redesign or distributed scheduler. Existing platform defects/limits remain explicit rather than bypassed.
- Preserve current capabilities and distinguish authored recipes from executable methods. Use supported GRPO/reward-model paths for the base; do not reduce the product to data submission alone.
- Reuse current account/authentication and API operations. Before using OpenPond CLI for validation, inspect its help and use the running app's OpenPond home; missing credentials in a different default home are not a login failure.
- Keep this work focused on SDK access. No UI redesign, new notification behavior or duplicate runtime/orchestration layer is needed.
- Extend meaningful consumer/integration/end-to-end validation. Do not introduce isolated unit, prose/registry/wiring tests, broad typechecks or routine paid GPU CI. Selective package checks apply only when implementation changes warrant them.
- Larger models, full-parameter training, Runpod Clusters, Slurm/Slinky and Prime-RL adoption are deferred. Their availability does not make them part of the SDK foundation.

## Phases

### Phase 0 — Freeze today's supported developer workflow

- [x] Record the narrower delivery sequence. Done: source-backed inventory above separates existing SDK/job capabilities, the missing Python package and later trainer/method expansion; linked parent review owns the broader context.
- [x] Complete the operation matrix for current training/data/reward/harness/evaluation/learning behavior. Done:69 current client methods map to9 source-pinned authority domains with per-operation classifications and Python methods; hosted and Desktop route availability are separate, and actual proof states remain explicit. The estimate client has no current hosted endpoint and is deferred; private/new trainer methods remain outside the base. See the linked operation matrix and root source review above.
- [ ] Finalize Python distribution/import names, supported Python versions, HTTP/model dependencies, schema/fixture generation and release tooling. Acceptance: source under `python/openpond-sdk/` in this repository, uv-managed development/builds, PyPI as the distribution target and verified package ownership/name availability, without forcing Node into the normal Python hosted workflow.
- [ ] Define one existing-method manual training workflow and one continual workflow for both languages. Acceptance: exact inputs, approvals, capabilities and observable terminal results are identified; real model/runtime proof is not claimed from local fixtures.

### Phase 1 — Complete the existing TypeScript surface

- [x] Fill verified public-client gaps for the Phase 0 matrix and add only necessary API exposure of existing behavior. Done:68 source-backed hosted operations use existing public clients; the missing estimate endpoint is explicitly deferred and excluded from runnable examples. Training/Model clients now bound response bytes during consumption, with the representative real HTTP stream integration passing for both factories. No new private API or trainer feature is required for the declared existing-resource workflow; deployed acceptance remains Phase3 work.
- [ ] Prepare the additional Ponder npm distribution using the existing SDK implementation. Acceptance: root/subpath runtime and TypeScript exports match `openpond-sdk`, its dependency pins the exact corresponding release, and clean consumers can use either package name without divergent behavior. Reuse current SDK release tooling, extending its hard-coded package identity where needed; do not replace the existing distribution.
- [x] Make current lifecycle usage clear and consistent. Done:the public workflow guide records authentication/scope, expected revisions/hashes, bounded reads, pagination, caller-supplied finite timeout/abort, explicit remote cancellation and same-identity reconciliation of uncertain writes. The bounded-reader correction and real HTTP stream proof cover the found response-allocation gap; local cancellation never claims to stop remote compute.
- [ ] Provide a runnable current-GRPO workflow and a current continual-learning workflow. Acceptance: they use the public SDK and existing reusable resources; reward-model jobs are represented according to actual capability/route availability.

### Phase 2 — Add Python for the same capabilities

- [x] Implement the Python package against the same operation matrix. Done: 69 typed sync/async methods cover the declared configuration, resources, learning, preparation, training and evaluation/review contracts; the one missing hosted estimate method refuses before dispatch. Independent source review verifies the shared matrix and operation-specific media, consent and response pins. Deployed workflow proof remains in Phase 3.
- [x] Establish the uv package layout and build configuration. Done: `python/openpond-sdk/` has a locked uv environment, pinned build backend, Python 3.10+ and MIT metadata. `uv build --no-sources` produces a wheel and source distribution; isolated pip/uv consumers on Python 3.10 and 3.14 install the exact wheel without Node or monorepo imports. Publication is a separate Phase 3 gate.
- [x] Implement portable wire validation, identity and transport behavior. Done: source-generated input/output schemas preserve defaults, strip/strict/record behavior and supported transforms; shared JavaScript vectors cover Unicode, prototype keys, integer enumeration and binary64 serialization. Native transport bounds response bytes, keeps writes unreplayed, sanitizes errors and enforces cursor/scope/revision/hash pins. Two representative HTTP/wire tests pass. Synchronous inactivity limits and the distinct host-authenticated Harness seals remain explicit; actual hosted denial/recovery proof is not inferred.
- [ ] Ship matching Python examples and documentation. Acceptance: an ordinary external Python consumer completes the hosted reviewed-batch workflow without a Node subprocess; advanced prepared artifacts and current Python-authoring limits are explained accurately.

### Phase 3 — Prove and release the SDK foundation

- [ ] Verify packed TypeScript and built Python distributions in clean external consumers. Acceptance: no workspace/private imports, missing runtime files or monorepo-only dependencies; schemas/fixtures and documentation match packaged capabilities.
- [ ] Prepare PyPI distribution and installation documentation. Acceptance: verified project ownership, versioned release automation and clean pip/uv installation of the same wheel, with no uv or Node runtime requirement for pip consumers. Publishing uses the repository's selected release flow after verifying publisher ownership; this document does not reserve a registry name.
- [ ] Coordinate the additional npm package release. Acceptance: verified name/publisher control, `openpond-sdk` publication before the exact-version Ponder wrapper, retained provenance and independent reconciliation of partially completed publication; root/subpath imports work from the actual packed distributions.
- [ ] Extend representative integration/end-to-end workflows across real boundaries. Acceptance: equivalent current-method requests/results in both languages, wrong-team denial, stale revisions, duplicate submission/lost-reply reconciliation, pagination and cancellation/recovery behavior. Reuse retained outputs for read-only paths; any real compute proof has a separately explicit budget.
- [ ] Validate current manual and continual workflows against the deployed API and record exact versions/SHAs, inputs, result references and limits. Acceptance: source/package checks are distinguished from actual hosted model execution; current platform gates remain owned by the platform doc.
- [ ] Prepare versioned package releases and capability documentation using current official release tooling. Acceptance: Python and TypeScript supported surfaces are explicit, current GRPO/reward-model availability is accurate, and no future SFT/DPO/session feature is described as shipped. Actual publication/deployment follows the release request and repository flow.

Phases 0–3 define a complete base release. Later unchecked phases do not make that release incomplete.

### Phase 4 — Later per-operation training control

- [ ] Design and implement deeper control after the base is established. Acceptance: selected sessions, tokenized sampling/forward passes, caller-authored batches/advantages, gradient accumulation/updates and deliberate checkpoint/sampler operations have a shared contract and real runtime support. Do not require every possible loss or optimizer to expose the first useful control surface.
- [ ] Extend both SDKs and existing eval/harness integration for those operations. Acceptance: a caller-owned RL loop preserves policy identity, update ordering, idempotency, funding, checkpoint restoration and terminal cleanup within the existing Run lifecycle.

### Phase 5 — Later SFT

- [ ] Implement executable SFT on the selected supported runtime. Acceptance: supervised targets/token weights, batching, optimizer behavior and checkpoints produce actual updates; capability admission and retained evaluation match the implementation.
- [ ] Expose the recipe in both SDKs and the applicable existing product flows. Acceptance: a complete SFT example works through preparation, execution, evaluation and existing candidate review; no larger-model/distributed requirement is introduced by default.

### Phase 6 — Later DPO

- [ ] Implement executable DPO on the selected supported runtime. Acceptance: approved chosen/rejected pairs, reference-policy/logprob identity, actual preference updates and checkpoint/evaluation evidence; preference rewards feeding GRPO are not labeled DPO.
- [ ] Expose DPO in both SDKs and applicable managed/continual flows where data requirements are met. Acceptance: an external consumer completes the workflow with consistent capabilities, budget and lineage; support is not inferred from existing recipe schemas.

## Validation and Acceptance

Current local evidence covers the single TypeScript real HTTP stream/media boundary, two Python HTTP/wire tests, independent source reviews, uv wheel/source builds and four exact-wheel pip/uv consumers on Python 3.10/3.14. The first wrapper runtime check against registry SDK 0.12.6 is mechanism evidence only. The release candidate is SDK/Ponder 0.12.8 and Python 0.1.0; fresh TypeScript artifacts and CI remain separate gates. No local typecheck or heavy application build was run for this foundation work.

The source PR adds the Python boundary to the existing Python CI jobs, without a new lane. Manual PyPI release automation retains one source-bound build artifact for review and publishes those exact bytes only after publisher bootstrap, protected environment approval and trusted-publisher setup; it reconciles immutable registry digests. npm publishes the original SDK before its exact-version Ponder wrapper. Neither registry name availability nor a local wheel establishes ownership. Actual publication, deployed API workflows and real model execution are still unqualified.

Base completion requires complete declared workflows in both languages and the documented identity/authorization/lifecycle boundaries. It does not require SFT, DPO, per-gradient control, a new model catalog or distributed training.

## Open Questions

- Which maintainer accounts own the first npm/PyPI `ponder-sdk` releases, and who can configure their trusted publishers? Candidate names and Python import `ponder_sdk` are selected; public absence does not establish control.
- Which retained hosted receipts can qualify unchanged read-only paths, and which current manual/continual writes still need live proof? Record these after the security gates, with separate finite bounds for any new compute.

## Progress Log

- 2026-10-24 05:22Z: Recorded the owner’s security-first foundation scope, completed the reviewed Python implementation/build/wire rows, and retained package publication and hosted workflow gates. Source and local package evidence do not close deployed acceptance.

- 2026-10-23 22:59Z: Recorded proposed Python `ponder-sdk`/`ponder_sdk` naming and the requested additional Ponder npm distribution of the existing SDK. Reviewed hard-coded SDK release identities and public subpath exports; recommended generated re-exports with an exact dependency and one implementation. Both registry metadata checks returned 404; no reservation, rename, implementation or publication performed.
- 2026-10-23: Owner confirmed Python source stays in the OpenPond repo, uses uv and is distributed through PyPI with pip/uv installation. Recorded `python/openpond-sdk/` layout, wheel/source-build and distribution acceptance; package naming/ownership and actual publication remain pending.
- 2026-10-23 22:50Z: Created the focused SDK/Python plan on owner request. Base Phases 0–3 cover current capabilities and complete external-consumer delivery; per-operation trainer control is Phase 4, SFT Phase 5 and DPO Phase 6. Larger models/distributed infrastructure remain deferred. Updated the broader review to point here and supersede its earlier all-at-once sequencing. Documentation only; no implementation or release started.
