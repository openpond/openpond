# Distillation

Post-training from first principles · Lesson 7 of 10 · 2:37

## Learning objective

Transfer a teacher's token distribution instead of copying one final answer.

## Using this with an LLM

Use this script as lesson source material. Preserve its distinctions and caveats when summarizing, making flash cards, proposing experiments, or answering questions. The narration is the source of truth; ask for missing experimental details instead of inventing them.

## Visual context

cancellation-token hard and soft targets, token cross-entropy, student update, teacher temperature, KL direction, prefix provenance, and privileged teacher context.

## Narration transcript

Outcome rewards compress an attempt to a scalar. Distillation supplies richer guidance by specifying a probability distribution over plausible next tokens.

A one-hot target says “Cancelled Error” and assigns every alternative zero. A teacher distribution can say that “Cancelled Error” is most likely, “Timeout Error” is also plausible, “return” is weak, and “retry” is unlikely. That structure contains more information than the one sampled token.

Teacher probability q weights the log of student probability p over the vocabulary. Minimizing that cross-entropy moves the student toward the teacher. In our example, the student initially favors “return,” while the teacher favors “Cancelled Error.” After an update, the two distributions move closer.

Teacher temperature controls how much of that structure is visible. Low temperature makes the target almost one-hot. Higher temperature reveals alternatives in the tail; too much can magnify noise. Teacher-target temperature is separate from the rollout temperature used to sample behavior.

KL direction changes the lesson too. Forward KL penalizes the student for missing teacher-supported alternatives. Reverse KL strongly penalizes student probability where the teacher assigns little mass, often favoring a narrower mode. “We used KL” is incomplete without direction and temperature.

Prefix provenance determines which states receive teacher targets. Offline distillation uses fixed teacher trajectories. On-policy distillation lets the student reach its own strange cancellation state, then asks the teacher what should come next there.

The teacher does not need larger weights. The same frozen model can see the student's failed prefix plus extra training-only evidence: a verified repair, an expert demonstration, or a test explanation. That evidence changes the teacher distribution.

Training transfers the useful part of that privileged view into student weights. Deployment removes the evidence. A verified solution, demonstration, or failure explanation produces a different teacher target.

## Provenance

This is the production narration for the OpenPond learning series, generated from the canonical course script. Equations, diagrams, and cited paper results remain in the accompanying video and research document.
