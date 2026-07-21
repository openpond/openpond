# Credible experiments

Post-training from first principles · Lesson 9 of 10 · 3:32

## Learning objective

Build versioned datasets, fair baselines, and claims that survive scrutiny.

## Using this with an LLM

Use this script as lesson source material. Preserve its distinctions and caveats when summarizing, making flash cards, proposing experiments, or answering questions. The narration is the source of truth; ask for missing experimental details instead of inventing them.

## Visual context

Taskset boundaries, Hugging Face import, baselines, evaluation, compute, experimental campaigns, claim table, synthesis.

## Narration transcript

A research result requires many versioned tasks, protected information boundaries, matched baselines, and held-out evaluation.

Policy-visible input includes the issue, repository revision, allowed tools, and public tests. Training-only evidence may contain an expert repair, privileged patch, or public diagnostic. Evaluator-only hidden tests, anti-exploit checks, and held-out repository clusters must remain outside both.

The Taskset preserves those boundaries together with source revision, license, split, verifier version, and content hash. Related issues from the same repository should be clustered before splitting; otherwise memorization can look like generalization.

Hugging Face support is worthwhile when it behaves as a reproducible importer. Pin the repository revision. Inspect the dataset card and license. Choose configuration and split explicitly. Map columns through a reviewed transform, log rejected rows, preserve original identifiers, and materialize an immutable snapshot. A training run should never silently follow a changing main branch.

Every proposed method needs a simple credible baseline. Begin with the base model and the most direct token-imitation objective supported by the data. Add offline distillation or preference learning when those signals are relevant. Compare with GRPO or another RLVR baseline before claiming value from OPSD, SDFT, or SDPO.

Equal optimizer tokens and equal total compute answer different questions. A distillation method may use fewer rollouts while spending additional teacher forward passes. Report both controls.

Evaluation should span four dimensions. Capability measures task success. Diversity measures pass-at-k, entropy, and distinct strategies. Retention tests old domains and distribution drift. Integrity audits reward exploits, leakage, and disagreement with a shadow verifier. A single average can hide serious regressions.

Compute accounting includes student rollout tokens, teacher-scored tokens, backward tokens, verifier time, external calls, failed jobs, memory, storage, and wall clock.

The primary study compares GRPO, SDPO, and a routed success-and-failure method on code repair while separating public diagnostics from hidden tests. Verified math can replicate the GRPO and OPSD claims with exact graders. A tool protocol can replicate token imitation and SDFT while measuring retention. The extra domains test whether a conclusion transfers; they do not replace the main story halfway through it.

The paper should bind every claim to a dataset revision, metric, run set, seed, confidence interval, and ablation. That structure keeps a local result from turning into a universal claim.

The final map is simple. Demonstrations produce imitation targets. Preferences produce relative targets. Verifiable outcomes produce rewards. Privileged solutions and failure explanations produce context-conditioned teacher distributions.

Evidence determines the target. The target determines the update. The update changes future behavior. Evaluation measures what improved—and what changed elsewhere.

## Provenance

This is the production narration for the OpenPond learning series, generated from the canonical course script. Equations, diagrams, and cited paper results remain in the accompanying video and research document.
