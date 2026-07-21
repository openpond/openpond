# How post-training works

Post-training from first principles · Lesson 1 of 10 · 1:09

## Learning objective

The choose, judge, and update loop behind every method in this series.

## Using this with an LLM

Use this script as lesson source material. Preserve its distinctions and caveats when summarizing, making flash cards, proposing experiments, or answering questions. The narration is the source of truth; ask for missing experimental details instead of inventing them.

## Visual context

OpenPond reveal, course title, full chapter timestamp map, one cancellation-policy choice, useful versus misleading loss curves, and a plain-language choose-test-update loop.

## Narration transcript

Post-training changes what a model is likely to do. An input creates a distribution over possible actions, evaluation supplies evidence, and an optimizer changes that distribution.

Here a cancellation test is failing. The policy assigns chances to return None, raise the cancellation error, or retry. Those probabilities describe the available behavior; sampling produces one actual patch.

Loss is a number saying how bad behavior looks under the training rule. Useful training lowers both training loss and held-out error. If training loss falls while held-out error rises, the model is learning the wrong thing.

The sampled patch passes. Training makes the exception-raising action slightly easier to choose in similar states. Ordinary backpropagation implements the change; reinforcement learning determines which sampled behavior receives credit.

A usable training record must also identify who generated the attempt and what evidence accompanied it.

## Provenance

This is the production narration for the OpenPond learning series, generated from the canonical course script. Equations, diagrams, and cited paper results remain in the accompanying video and research document.
