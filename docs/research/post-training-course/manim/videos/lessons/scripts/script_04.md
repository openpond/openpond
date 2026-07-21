# Rewards and credit assignment

Post-training from first principles · Lesson 4 of 10 · 3:00

## Learning objective

Follow a code-repair trajectory from actions and observations to advantage.

## Using this with an LLM

Use this script as lesson source material. Preserve its distinctions and caveats when summarizing, making flash cards, proposing experiments, or answering questions. The narration is the source of truth; ask for missing experimental details instead of inventing them.

## Visual context

trajectories, rollout tuples, feedback versus reward, credit assignment, discounted return, advantage, entropy, pass@k, reference KL.

## Narration transcript

An RL rollout is a sequence, not only a final response. Credit assignment asks which decisions inside that sequence should become more or less likely.

The issue and repository form state zero. The behavior policy samples “inspect files.” File contents are an environment observation, not another sampled action. The next state contains those contents. The policy then writes raise Cancelled Error, and test output closes the trajectory.

The tuple makes those roles explicit. Tau contains states, sampled actions, behavior log-probabilities, observations, and terminal reward. Gradients apply to action positions controlled by the policy. Observations condition later actions but are masked out of the policy-gradient loss.

Reward and feedback carry different information. A patch can receive reward zero while the environment still knows that eight tests passed, cancellation failed, and the expected exception was Cancelled Error. Reward is the scalar consumed by an objective. Feedback is the richer evidence the environment produced.

A terminal score also leaves the cause ambiguous. Was the wrong file inspected? Was the timeout branch incorrect? Was “None” the decisive token? Response-level credit applies one outcome broadly. Step- or token-level signals can be denser, but density alone does not prove causal accuracy.

For multi-step problems, return carries future rewards backward. G at time t is the discounted sum of later rewards. With gamma point nine and success two steps later, the earlier action receives return point eight one. PPO critics and Generalized Advantage Estimation, or GAE, build on this idea.

Advantage then asks: better than what was expected? If observed return is point eight and the baseline is point five, advantage is positive point three. A return of point two gives negative point three.

Positive advantage raises the sampled behavior’s probability; negative advantage lowers it. PPO learns a critic for the baseline. GRPO replaces that critic with statistics from sibling responses.

Learning also changes exploration. Pass-at-one can rise while entropy and pass-at-k fall if the model collapses onto one strategy. Reliability and breadth therefore need separate metrics.

Finally, a frozen reference policy anchors behavior outside the optimized task. Kullback–Leibler divergence, shortened to KL, measures distribution shift. Too little constraint permits drift and reward exploits; too much prevents useful learning.

A test-based reward is useful only when the test measures the intended outcome reliably.

## Provenance

This is the production narration for the OpenPond learning series, generated from the canonical course script. Equations, diagrams, and cited paper results remain in the accompanying video and research document.
