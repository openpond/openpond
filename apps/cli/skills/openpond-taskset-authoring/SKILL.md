---
name: openpond-taskset-authoring
description: Turn consented OpenPond conversations and traces into provider-neutral Tasksets, executable graders, baseline plans, readiness reports, and inspectable SFT handoffs.
metadata:
  short-description: Author training Tasksets
---

# OpenPond Taskset Authoring

Use this skill when `/train`, the Training page, a selected conversation, or a Task Miner suggestion asks you to define a learnable capability.

## Required workflow

1. Inspect only the explicitly selected evidence. Cite source IDs; never copy unrelated conversation history.
2. Separate policy-visible input from privileged outcome and grader state.
3. Inventory existing demonstrations, corrections, preferences, labels, feedback, and verifiable rewards. Do not fabricate expert approval.
4. Recommend `no_training` or retrieval when weights are not the right memory layer.
5. Draft one provider-neutral `TaskDesignProposal` with a bounded objective, task instances, split-cluster keys, graders, calibration fixtures, and assumptions. Keep the user-facing name and objective natural: describe the repeated job and desired outcome in one or two short sentences.
6. Ask a question only for a blocking ambiguity: objective, consent, success signal, privacy/licensing boundary, or mutually exclusive interpretations.
7. Prefer deterministic graders. A model judge must be declared, pinned, calibrated, versioned, and recorded; it is not deterministic.
8. Run validation, positive/negative/boundary/adversarial grader fixtures, baselines, leakage checks, and reward-hacking checks.
9. Materialize only after approval, then show the generated diff and readiness blockers.
10. Training requires a separate approval for destination, method, model, data export, retention, and budget.

Never put source IDs, hashes, cluster keys, split-placement rules, consent boilerplate, privileged expected values, encodings, or grader implementation details in the proposal name or objective. Keep those details in source references, policy boundaries, grader configuration, assumptions, warnings, and generated code.

Treat synthetic smoke fixtures as diagnostics, not representative business tasks. When the only evidence is a trivial fixed response or exact string, recommend `no_training`, explain that application logic or prompting is sufficient, and still use a short human description if a diagnostic Taskset is explicitly requested.

Use `Create with defaults` when evidence is sufficient. Record reversible assumptions and proceed to the single materialization approval. Use `Customize` for a conversational design pass.

Read only the reference needed for the current decision:

- Task reconstruction and split isolation: `references/task-design.md`
- Graders, reward eligibility, and calibration: `references/graders-and-rewards.md`
- Method selection and readiness: `references/method-selection.md`
- Privacy, consent, and provenance: `references/privacy-and-provenance.md`
