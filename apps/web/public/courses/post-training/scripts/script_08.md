# OPSD, SDFT, and SDPO

Post-training from first principles · Lesson 8 of 10 · 2:38

## Learning objective

Compare trusted solutions, demonstrations, and failure feedback at one prefix.

## Using this with an LLM

Use this script as lesson source material. Preserve its distinctions and caveats when summarizing, making flash cards, proposing experiments, or answering questions. The narration is the source of truth; ask for missing experimental details instead of inventing them.

## Visual context

one failed cancellation patch with three teacher evidence channels, OPSD/SDFT/SDPO worked examples, evidence comparison, and shared failure modes.

## Narration transcript

OPSD, SDFT, and SDPO share one mechanism. A frozen teacher scores the student's prefix while receiving additional evidence. The evidence source defines the method.

The student distribution is p theta given the issue and its prefix. Teacher target q scores the same next token at the same prefix, but also conditions on evidence e. Training matches q into p; deployment removes e.

On-Policy Self-Distillation, or OPSD, gives the teacher a trusted solution. Here that is the verified repair: preserve cleanup and raise Cancelled Error. The teacher uses it to guide the student's own prefix without placing the privileged patch in the deployed student's prompt. The OPSD paper evaluated this mechanism on reasoning tasks; the animation maps the information flow onto our code case.

Self-Distillation Fine-Tuning, or SDFT, gives the teacher an expert demonstration. A related repair shows the sequence inspect the flag, run cleanup, then raise the exception. Unlike offline imitation, SDFT scores the current student's return-None prefix, so the demonstration guides the state the student actually reached.

Self-Distillation Policy Optimization, or SDPO, gives the teacher feedback about the current failure. The scalar reward is zero, but the test trace says test-cancel failed, expected Cancelled Error, and return skipped cancellation. The teacher converts that explanation into dense token probabilities along the failed prefix.

The choice follows the evidence. A trusted solution supports OPSD. A demonstration supports SDFT. An explanatory failure trace supports SDPO. If all you have is a binary outcome, GRPO may be the honest baseline; inventing a generic “feedback” field would hide these different trust boundaries.

None of the dense methods is automatically safe. A privileged patch can leak. A demonstration can be irrelevant. A teacher can misread feedback and densify an error. New capability can overwrite old behavior, entropy can collapse, and teacher forward passes can erase claimed efficiency savings.

So the durable comparison is not acronym against acronym. Hold the student prefix fixed, vary the evidence, record the cost, and measure both the cancellation repair and unrelated retained capability.

## Provenance

This is the production narration for the OpenPond learning series, generated from the canonical course script. Equations, diagrams, and cited paper results remain in the accompanying video and research document.
