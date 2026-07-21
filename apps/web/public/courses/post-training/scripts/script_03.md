# On-policy and off-policy data

Post-training from first principles · Lesson 3 of 10 · 1:02

## Learning objective

Why learner rollouts and teacher or stored data support different updates.

## Using this with an LLM

Use this script as lesson source material. Preserve its distinctions and caveats when summarizing, making flash cards, proposing experiments, or answering questions. The narration is the source of truth; ask for missing experimental details instead of inventing them.

## Visual context

on- and off-policy sources, a concrete rollout record, stored-data schemas, and objective routing.

## Narration transcript

On-policy data comes from the learner being updated. Policy version twelve generates an attempt that will update version twelve.

Off-policy data comes from a teacher, human, or older checkpoint. These labels describe source, not quality.

An RL rollout stores the problem, sampled actions, generating checkpoint, behavior probabilities, environment observations, and reward.

Text alone cannot connect evaluated behavior to an update. The missing record matters as much as the final response.

Other sources carry different signals: teacher targets, chosen and rejected responses, or old actions with original probabilities and rewards.

PPO and GRPO usually score learner attempts. Offline distillation uses teacher examples. On-policy distillation labels the student's current prefix.

Inside any RL rollout, the final patch is only one part of a sequence of actions and observations.

## Provenance

This is the production narration for the OpenPond learning series, generated from the canonical course script. Equations, diagrams, and cited paper results remain in the accompanying video and research document.
