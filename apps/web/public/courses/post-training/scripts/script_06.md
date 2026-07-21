# PPO and GRPO

Post-training from first principles · Lesson 6 of 10 · 2:54

## Learning objective

Compare PPO's learned critic with GRPO's sibling-response baseline.

## Using this with an LLM

Use this script as lesson source material. Preserve its distinctions and caveats when summarizing, making flash cards, proposing experiments, or answering questions. The narration is the source of truth; ask for missing experimental details instead of inventing them.

## Visual context

PPO's critic on the cancellation trajectory, GRPO sibling patch attempts, worked group advantages, clipping, mixed-group probability, zero-variance groups, and direct comparison.

## Narration transcript

A trustworthy reward still has to become a learning signal. PPO and GRPO differ mainly in how they decide whether an outcome was better or worse than expected.

PPO means Proximal Policy Optimization. For the successful inspect, patch, and test trajectory, observed return is point eight. A learned critic expected point five. Their difference, positive point three, is the advantage. PPO combines that advantage with a clipped probability ratio and updates the policy.

GRPO means Group Relative Policy Optimization. It keeps rollouts, rewards, probability ratios, and clipping, but removes the critic. Instead, it samples several patches for the same cancellation bug and compares their verifier scores.

Our six sibling patches produce rewards one, zero, zero, one, one, zero. The mean is one half and the standard deviation is one half. Normalizing gives every passing patch advantage positive one and every failing patch negative one.

That comparison is useful but coarse. Raise Timeout Error and return None both failed, so binary GRPO treats them alike even if one was closer. The group says which siblings did better; it does not explain why.

The clipping graph controls how much one sampled action can influence a single update. If its probability moves from point one zero to point one three, the ratio is one point three. With a cap at one point two, additional positive credit stops growing. Clipping limits a local incentive; it does not guarantee that the whole policy stayed close.

A group teaches only when it contains contrast. If one patch succeeds with probability p, a group of size G is mixed with probability one minus p to the G minus one minus p, all to the G. That subtracts all-success and all-failure groups.

Near zero success, almost every group fails. Near one, almost every group passes. Either case produces little relative signal. Larger groups widen the useful middle but require more patch generation and test execution.

This is why prompts need to sit near the learning frontier: difficult enough to fail, possible enough to solve. If every cancellation patch receives the same reward, normalized group advantage is zero.

Both PPO and GRPO need trajectories, rewards, behavior log-probabilities, clipped ratios, and gradients. PPO learns expected value with a critic. GRPO estimates a baseline from sibling patches. The cancellation environment stays the same; only the baseline estimator changes.

## Provenance

This is the production narration for the OpenPond learning series, generated from the canonical course script. Equations, diagrams, and cited paper results remain in the accompanying video and research document.
