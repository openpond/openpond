# Technical appendix

Post-training from first principles · Lesson 10 of 10 · 3:07

## Learning objective

Inspect implementation choices and paper-specific results after the core mechanisms are clear.

## Using this with an LLM

Use this script as lesson source material. Preserve its distinctions and caveats when summarizing, making flash cards, proposing experiments, or answering questions. The narration is the source of truth; ask for missing experimental details instead of inventing them.

## Visual context

Length-normalization equations and pass-at-k curves; full versus top-k teacher-logit storage; paper-reported OPSD, SDFT, and SDPO bars; and an SRPO success/failure routing diagram.

## Narration transcript

### GRPO details

The first appendix isolates two GRPO evaluation choices that matter after the main mechanism is understood.

Length normalization changes gradient weight. A fourteen-hundred-token correct answer and a one-hundred-eighty-token correct answer may receive the same reward but contribute very different numbers of token terms. Sequence averaging, token averaging, overlong penalties, and group normalization therefore change the effective objective.

Pass-at-one measures reliability from one sample. Pass-at-k asks whether any of k samples succeeds and exposes remaining search diversity. A model can improve pass-at-one while collapsing onto one strategy, so report both metrics with the sampling configuration.

### Distillation systems

The systems problem is storage. A large vocabulary creates one teacher logit for every token at every trajectory position.

Top-k compression stores the most likely teacher logits and approximates the remaining tail. This reduces memory and bandwidth but changes the target distribution. Measure divergence from full logits on a validation sample, and count teacher-forward cost when comparing efficiency.

### Paper details and SRPO

The reported graphs belong in an appendix because they come from different models, datasets, and experimental budgets.

The OPSD study reports its largest displayed aggregate gain at the smallest Qwen3 model. At one point seven billion parameters, the displayed base score is thirty-seven point one, GRPO is thirty-seven point seven, and OPSD is forty-three point four. The gaps are smaller at four and eight billion parameters. That is a hypothesis for replication, not a universal model-size law.

The SDFT study emphasizes knowledge acquisition and retention. Its displayed strict aggregate moves from eighty to eighty-nine, while its out-of-distribution aggregate moves from eighty to ninety-eight. The SDPO study reports forty-one point two for GRPO and forty-eight point eight for SDPO on its code benchmark. Their bars answer different questions and should not be read as a controlled head-to-head comparison.

SRPO means Sample-Routed Policy Optimization. It sends verified successes toward a GRPO-style outcome update and failures with explanations toward an SDPO-style corrective target.

The useful principle is signal routing. A successful rollout already shows what worked and can support sparse selection. A failed rollout with diagnostics may reveal how to recover and can support dense correction. The router preserves that asymmetry instead of forcing every sample through one uniform loss.

## Provenance

This is the production narration for the OpenPond learning series, generated from the canonical course script. Equations, diagrams, and cited paper results remain in the accompanying video and research document.
