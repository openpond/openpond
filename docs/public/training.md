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

## Plan, Approve, and Run

Once the Taskset is ready:

1. Choose a base model, SFT recipe, and compatible destination.
2. Review compatibility, data policy, retention, region, and estimated cost assumptions.
3. Approve the exact source set and data export boundary.
4. Build and validate a content-addressed training bundle.
5. Approve the destination, method, model, bundle, and budget.
6. Launch the job, collect artifacts, run the frozen evaluation, and inspect lineage before using the result.

Bundles contain approved training records, the recipe, policy, and provenance. They exclude raw chats, secrets, and hidden grader assets. Their file hashes and Taskset hash make the handoff inspectable and reproducible.

The open-source repository currently provides bundle export and an optional non-production local CPU training fixture. CUDA and MLX destinations remain unavailable until their live worker conformance is proven. OpenPond Managed is currently a client stub, Prime and Fireworks are not connected in this build, SSH GPU execution is deferred, and custom execution requires a registered destination implementation. The local worker lives in `python/openpond-training` and requires Python `>=3.10,<3.13` plus `uv`.

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
