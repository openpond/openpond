# Verifiable rewards

Post-training from first principles · Lesson 5 of 10 · 2:53

## Learning objective

See how tests create scalable rewards—and how a model can exploit the checker.

## Using this with an LLM

Use this script as lesson source material. Preserve its distinctions and caveats when summarizing, making flash cards, proposing experiments, or answering questions. The narration is the source of truth; ask for missing experimental details instead of inventing them.

## Visual context

the cancellation test as verifier, RLVR definition, verifier equation, executable loop, secondary applications, verifier errors, reward hacking, and hidden evaluation.

## Narration transcript

Every reward-based update depends on whether its evaluator measures the right thing. This is the verifier problem.

RLVR means Reinforcement Learning with Verifiable Rewards. For our repair, the verifier applies the patch, runs the cancellation tests, and returns a reproducible outcome. The same idea applies to checked math answers, tool states, and agent environments.

A preference such as “patch A is cleaner” depends on a judge. A verifiable reward applies an explicit rule. Verifiable does not mean infallible; it means the same patch should receive the same result under the same evaluator state.

Write the rule as r equals V of x, y, and e. X is the public task. Y is the sampled attempt. E is evaluator-only state such as hidden tests. For a binary verifier, reward is zero or one.

This equation separates the setting from the optimizer. RLVR supplies reward. PPO, GRPO, or another policy optimizer supplies the update. DeepSeek-R1 is an important example of reasoning training built from this combination.

The full loop is prompt, policy attempt, execution, verification, reward, and policy update. Automatic checks scale because a person does not need to score every trajectory. The verifier also becomes both the task specification and an attack surface.

RLVR applies beyond short math answers. Code can compile and run tests. Tool agents can be checked against a target database state. Search can verify retrieved evidence. Scientific tasks can use simulators and constraints. It is a poor fit when quality is inherently subjective, outcomes cannot be reproduced, or the checker is easy to game.

Verifier errors have two directions. A false negative rejects a valid solution. A false positive is more dangerous under optimization because a wrong solution receives positive gradient and can become an exploit.

Suppose visible tests cover only three examples. Hard-coding those outputs and implementing the general rule both receive reward one. The optimizer cannot distinguish them. Hidden tests, randomized cases, invariants, and shadow verifiers make the measured objective closer to the intended task.

That requires an information boundary. The policy sees the public task and allowed observations. The evaluator alone sees hidden checks and anti-cheat state. Training-only teacher evidence belongs in a third protected channel.

So “RLVR with GRPO” is precise: the first term names how outcomes are labeled, and the second names how those labels become an update.

## Provenance

This is the production narration for the OpenPond learning series, generated from the canonical course script. Equations, diagrams, and cited paper results remain in the accompanying video and research document.
