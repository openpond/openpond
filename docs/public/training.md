# Training From Real Work

OpenPond treats conversations as evidence, not automatically as training data. The training workflow turns explicitly selected, useful work into inspectable evaluations and high-signal training inputs while preserving consent, provenance, split isolation, grader behavior, and an approval boundary before data leaves the local workflow.

## Start With Evidence

Use `Add to training` from a chat, run `/train` in the composer, or start a **New model** flow from the Training page. The selected chats become source references for one bounded capability; unrelated history is not silently added.

OpenPond first diagnoses whether the behavior belongs in model weights. Stable, repeated behavior with evidence and a verifiable success signal may be training-eligible. Changing knowledge, missing runtime context, a deterministic lookup, or a task better solved by prompting or retrieval should produce a no-training recommendation instead of a forced dataset.

Training examples remain labeled by origin: extracted, corrected, synthetic, or expert-authored. Historical assistant output is candidate evidence, not automatically an approved demonstration.

## Build a Taskset

A Taskset is the reviewable contract for training and evaluation. It contains:

- A bounded objective and capability diagnosis.
- Source references and authoring provenance.
- Typed task inputs, expected outcomes, and policy boundaries.
- Isolated `train`, `validation`, and `frozen_eval` splits.
- Deterministic graders where possible, plus calibration fixtures for any declared model judge.
- Positive, negative, boundary, and adversarial fixtures.
- Environment and capability requirements needed to reproduce an attempt.

OpenPond keeps privileged outcomes and grader assets separate from policy-visible task input. Split-cluster isolation, leakage checks, reward-hacking checks, and grader audits help prevent an apparently good score from hiding a broken evaluation.

Tasksets are materialized as ordinary files under the active profile's `tasksets/` directory only after review and approval. You can inspect and edit the generated source, run it locally, and commit it with the rest of the profile.

## Prove Readiness

Before training, run baselines across the relevant models, seeds, and attempts. OpenPond records outputs, grades, infrastructure failures, cost, latency, and user intervention so the result can be compared rather than judged from one favorable run.

A Taskset is ready only after its validation, grader audit, evaluation coverage, leakage checks, and other readiness requirements pass. Training plans reject Tasksets that still have readiness blockers.

### Local execution isolation

Local cross-system `run_python` calls require Linux, system Python 3, bubblewrap
at `/usr/bin/bwrap`, and enabled unprivileged user namespaces. Each attempt gets
a private network, process namespace, and temporary filesystem. Only the Python
runtime and system libraries are mounted read-only; the host home, repository,
credentials, and grader files are not mounted. Python state persists between tool
calls within an attempt and is discarded when that attempt closes. The Python
import allowlist describes supported modules; OS isolation enforces security.

If isolation cannot start, the rollout reports an infrastructure failure and is
not eligible for a policy reward. It never retries outside the sandbox. Hosts
without this Linux runtime must use a qualified isolated execution host.

Local Taskset Work commands also run offline with a cleared environment. Stage
dependencies and task inputs before execution; package downloads and host-local
services are unavailable during a rollout. Model requests remain outside the
command sandbox. Hosted rollout endpoints have separate network policies.

Qualify a Linux execution host with
`pnpm exec vitest run --project root-qualification tests/python-sandbox.test.ts tests/local-taskset-network-isolation.test.ts`.
These checks execute real network and filesystem boundary probes and fail when
the isolation runtime is unavailable.

For a remote smoke test, run
`pnpm exec tsx scripts/testing/python-sandbox-staging-smoke.ts --bootstrap`
with a saved staging CLI account. It uploads the exact executor bundle to a
disposable staging Work guest, installs bubblewrap there if needed, verifies
the bundle hash and isolation checks, then deletes the guest. The guest has a
$0.10 spend cap. Results are written to `tmp/python-isolation-staging/report.json`.
This qualifies the executor in that guest; it does not publish a desktop release
or change the hosted service's runtime image. A permanent execution host still
needs bubblewrap and Python provisioned before accepting these rollouts.

## Plan, Approve, and Run

Once the Taskset is ready:

1. Choose a base model, SFT recipe, and compatible destination.
2. Review compatibility, data policy, retention, region, and estimated cost assumptions.
3. Approve the exact source set and data export boundary.
4. Build and validate a content-addressed training bundle.
5. Approve the destination, method, model, bundle, and budget.
6. Launch the job, collect artifacts, run the frozen evaluation, and inspect lineage before using the result.

Bundles contain approved training records, the recipe, policy, and provenance. They exclude raw chats, secrets, and hidden grader assets. Their file hashes and Taskset hash make the handoff inspectable and reproducible.

The open-source repository provides bundle export and an optional non-production local CPU training fixture. OpenPond Managed is the hosted compute option when it is available for the signed-in account. Connected and direct-provider destinations appear only when their required worker and destination integrations are configured. The local worker lives in `python/openpond-training` and requires Python `>=3.10,<3.13` plus `uv`.

## The Full Loop

```text
chat with models and agents
-> select consented evidence
-> diagnose whether training is appropriate
-> create and review a verifiable Taskset
-> audit graders and run baselines
-> approve and build a portable training bundle
-> train or export through a compatible destination
-> evaluate the artifact and bring it back to the same harness
```

The result is not an opaque dump of chat history. It is a source-backed job definition, evaluation suite, data policy, training handoff, and artifact lineage that the team can inspect and improve.
