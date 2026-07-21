"""Chapter 2: the notation, objectives, and acronyms used by the course."""

from manimlib import *

from components import BarDatum, arrow_between, bar_chart, node, panel, pill, text
from course_base import LessonScene
from theme import AMBER, BLUE, CORAL, CYAN, GREEN, INK, MUTED, VIOLET


class Chapter02Definitions(LessonScene):
    chapter_number = 2
    chapter_color = VIOLET
    hold_scale = 6.25

    def construct(self) -> None:
        self.lesson_intro(
            "Definitions",
            "The symbols and terms used throughout reinforcement fine-tuning.",
        )
        self._policy_notation()
        self._logits()
        self._softmax()
        self._trajectory_notation()
        self._reward_definition()
        self._reward_to_advantage()
        self._ppo_definition()
        self._grpo_definition()
        self._baseline_estimators()
        self._gradient_update()
        self._policy_ratio()
        self._distribution_terms()
        self._rl_acronyms()
        self._teacher_acronyms()

    def _policy_notation(self) -> None:
        heading = self.heading(
            "Policy notation",
            "Definitions",
            subtitle="Read πθ(a|s) as the probability of action a in state s under model parameters θ.",
        )
        formula = text("πθ(a | s)", size=68, color=INK, weight="BOLD")
        formula.move_to(UP * 1.05)
        terms = VGroup(
            node("π  policy\na distribution", color=CYAN, width=2.3, height=1.2, size=18),
            node("θ  parameters\nmodel weights", color=VIOLET, width=2.3, height=1.2, size=18),
            node("a  action\ntoken or tool call", color=GREEN, width=2.3, height=1.2, size=18),
            node("s  state\ncurrent context", color=BLUE, width=2.3, height=1.2, size=18),
        ).arrange(RIGHT, buff=0.48)
        terms.move_to(DOWN * 0.8)
        guides = VGroup(
            *[
                Line(
                    formula.get_bottom() + RIGHT * offset,
                    term.get_top(),
                    color=term[1].get_color(),
                    stroke_width=2,
                )
                for offset, term in zip([-1.3, -0.45, 0.45, 1.3], terms)
            ]
        )
        takeaway = self.conclusion(
            "A policy is not one answer; it is the full distribution the model can sample from."
        )
        self.reveal(heading, formula)
        self.play(
            LaggedStart(*[ShowCreation(guide) for guide in guides], lag_ratio=0.10),
            LaggedStart(*[FadeIn(term) for term in terms], lag_ratio=0.10),
            run_time=1.45,
        )
        self.reveal(takeaway)
        self.hold(3.4)
        self.wipe()

    def _logits(self) -> None:
        heading = self.heading(
            "Logits",
            "Definitions",
            subtitle="A logit is a raw score produced by the model before those scores become probabilities.",
        )
        scores = bar_chart(
            [
                BarDatum("raise", 3.0, CYAN),
                BarDatum("return", 1.0, MUTED),
                BarDatum("retry", 0.2, MUTED),
            ],
            max_value=3.2,
            width=5.2,
            height=3.25,
            value_decimals=1,
        )
        scores.move_to(LEFT * 3.15 + DOWN * 0.15)
        properties = panel(
            "RAW MODEL SCORES  z",
            [
                "can be positive or negative",
                "do not have to sum to one",
                "larger means more preferred",
                "differences determine probability",
            ],
            color=CYAN,
            width=4.65,
            height=3.45,
            title_size=22,
            body_size=19,
        )
        properties.move_to(RIGHT * 3.35 + DOWN * 0.10)
        takeaway = self.conclusion(
            "A logit of 3.0 is not a 300% probability; it becomes meaningful only relative to the other logits."
        )
        self.reveal(heading)
        self.play(ShowCreation(scores), run_time=1.0)
        self.reveal(properties, run_time=0.75)
        self.reveal(takeaway)
        self.hold(3.5)
        self.wipe()

    def _softmax(self) -> None:
        heading = self.heading(
            "Softmax",
            "Definitions",
            subtitle="Exponentiate each scaled logit, then divide by the total so every probability is positive and sums to one.",
        )
        logits = bar_chart(
            [
                BarDatum("raise", 3.0, CYAN),
                BarDatum("return", 1.0, MUTED),
                BarDatum("retry", 0.2, MUTED),
            ],
            max_value=3.2,
            width=3.8,
            height=3.15,
            value_decimals=1,
        )
        probabilities = bar_chart(
            [
                BarDatum("raise", 84, GREEN),
                BarDatum("return", 11, MUTED),
                BarDatum("retry", 5, MUTED),
            ],
            max_value=100,
            width=3.8,
            height=3.15,
            value_suffix="%",
            value_decimals=0,
        )
        logits.move_to(LEFT * 3.65 + DOWN * 0.15)
        probabilities.move_to(RIGHT * 3.65 + DOWN * 0.15)
        logits_label = text("logits  z", size=22, color=CYAN, weight="BOLD")
        probability_label = text("policy  πθ", size=22, color=GREEN, weight="BOLD")
        logits_label.next_to(logits, UP, buff=0.18)
        probability_label.next_to(probabilities, UP, buff=0.18)
        equation = text("softmax(zᵢ / T)", size=28, color=AMBER, weight="BOLD")
        arrow = Arrow(
            logits.get_right(),
            probabilities.get_left(),
            buff=0.42,
            color=AMBER,
            stroke_width=3,
        )
        equation.next_to(arrow, UP, buff=0.18)
        temperature = pill(
            "temperature T: lower = sharper · higher = flatter",
            VIOLET,
            width=5.0,
        )
        temperature.move_to(DOWN * 1.95)
        takeaway = self.conclusion(
            "softmax([3.0, 1.0, 0.2]) ≈ [84%, 11%, 5%]"
        )
        self.reveal(heading, logits, logits_label)
        self.play(ShowCreation(arrow), FadeIn(equation), run_time=0.85)
        self.reveal(probabilities, probability_label, run_time=0.8)
        self.reveal(temperature, run_time=0.5)
        self.reveal(takeaway, run_time=0.5)
        self.hold(3.7)
        self.wipe()

    def _trajectory_notation(self) -> None:
        heading = self.heading(
            "Rollout notation",
            "Definitions",
            subtitle="A rollout or trajectory records the decisions, observations, probabilities, and outcome.",
        )
        state = node("s₀\nstate", color=BLUE, width=1.55, height=1.05, size=18)
        action = node("a₀ ∼ μ\naction", color=CYAN, width=1.75, height=1.05, size=18)
        observation = node("o₁\nobservation", color=GREEN, width=1.85, height=1.05, size=18)
        next_state = node("s₁\nnext state", color=BLUE, width=1.75, height=1.05, size=18)
        reward = node("rT\nreward", color=AMBER, width=1.55, height=1.05, size=18)
        flow = VGroup(state, action, observation, next_state, reward).arrange(RIGHT, buff=0.46)
        flow.move_to(UP * 0.55)
        arrows = VGroup(
            *[
                arrow_between(flow[index], flow[index + 1], buff=0.10)
                for index in range(len(flow) - 1)
            ]
        )
        record = text(
            "τ = (s₀, a₀, log μ(a₀|s₀), o₁, s₁, …, rT)",
            size=31,
            color=INK,
            weight="BOLD",
        )
        record.move_to(DOWN * 0.85)
        provenance = VGroup(
            pill("μ · behavior policy that generated the action", VIOLET, width=4.25),
            pill("log μ · log-probability; products become sums", CYAN, width=4.35),
        ).arrange(RIGHT, buff=0.35)
        provenance.next_to(record, DOWN, buff=0.38)
        self.reveal(heading, state)
        for index, arrow in enumerate(arrows):
            self.play(ShowCreation(arrow), FadeIn(flow[index + 1]), run_time=0.48)
        self.play(TransformFromCopy(flow, record), run_time=0.8)
        self.reveal(provenance, run_time=0.55)
        self.hold(3.6)
        self.wipe()

    def _reward_definition(self) -> None:
        heading = self.heading(
            "Reward",
            "Definitions",
            subtitle="Reward is the scalar number an evaluator gives an action or completed trajectory.",
        )
        math = panel(
            "MATH ANSWER",
            ["exact match", "correct → r = 1", "incorrect → r = 0"],
            color=GREEN,
            width=3.35,
            height=3.0,
            title_size=22,
            body_size=19,
        )
        code = panel(
            "CODE PATCH",
            ["run hidden tests", "all pass → r = 1", "otherwise → r = 0"],
            color=CYAN,
            width=3.35,
            height=3.0,
            title_size=22,
            body_size=19,
        )
        tools = panel(
            "TOOL TASK",
            ["inspect final state", "target reached → r = 1", "wrong state → r = 0"],
            color=VIOLET,
            width=3.35,
            height=3.0,
            title_size=22,
            body_size=19,
        )
        examples = VGroup(math, code, tools).arrange(RIGHT, buff=0.50)
        examples.move_to(DOWN * 0.05)
        takeaway = self.conclusion(
            "Feedback can explain what happened; reward is the number the optimization objective consumes."
        )
        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(example, shift=UP * 0.08) for example in examples], lag_ratio=0.14),
            run_time=1.35,
        )
        self.reveal(takeaway)
        self.hold(3.8)
        self.wipe()

    def _reward_to_advantage(self) -> None:
        heading = self.heading(
            "Reward to advantage",
            "Definitions",
            subtitle="Reward scores an outcome; return carries rewards through time; advantage compares with a baseline.",
        )
        reward = panel(
            "REWARD  rₜ",
            ["score at one step", "tests pass → 1", "tests fail → 0"],
            color=AMBER,
            width=3.35,
            height=3.1,
            title_size=22,
            body_size=19,
        )
        returns = panel(
            "RETURN  Gₜ",
            ["future reward total", "Gₜ = rₜ + γGₜ₊₁", "γ = discount factor"],
            color=GREEN,
            width=3.35,
            height=3.1,
            title_size=22,
            body_size=19,
        )
        advantage = panel(
            "ADVANTAGE  Aₜ",
            ["better than expected", "Aₜ = Gₜ − baseline", "positive → raise probability"],
            color=CYAN,
            width=3.65,
            height=3.1,
            title_size=22,
            body_size=19,
        )
        cards = VGroup(reward, returns, advantage).arrange(RIGHT, buff=0.48)
        cards.move_to(DOWN * 0.1)
        worked = self.conclusion(
            "Example: Gₜ = 0.8 and baseline = 0.5 gives Aₜ = +0.3."
        )
        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(card, shift=UP * 0.08) for card in cards], lag_ratio=0.14),
            run_time=1.4,
        )
        self.reveal(worked)
        self.hold(3.8)
        self.wipe()

    def _ppo_definition(self) -> None:
        self.concept_card(
            "PPO",
            "Proximal Policy Optimization",
            "A policy-gradient method that compares return with a learned critic and clips large probability-ratio incentives.",
            "PPO learns a value model in addition to the policy.",
        )

    def _grpo_definition(self) -> None:
        self.concept_card(
            "GRPO",
            "Group Relative Policy Optimization",
            "A policy-gradient method that compares sibling responses for the same prompt and clips probability-ratio incentives.",
            "GRPO replaces the learned critic with group reward statistics.",
        )

    def _baseline_estimators(self) -> None:
        heading = self.heading(
            "Baselines",
            "Definitions",
            subtitle="A baseline estimates expected return so the update can focus on better- or worse-than-expected actions.",
        )
        ppo = panel(
            "PPO · LEARNED CRITIC",
            [
                "value function  Vφ(s)",
                "φ = critic parameters",
                "Aₜ ≈ Gₜ − Vφ(sₜ)",
                "GAE smooths multi-step estimates",
            ],
            color=CYAN,
            width=5.25,
            height=3.8,
            title_size=22,
            body_size=19,
        )
        grpo = panel(
            "GRPO · GROUP BASELINE",
            [
                "sample G sibling responses",
                "group mean  μG",
                "group standard deviation  σG",
                "Aᵢ = (rᵢ − μG) / σG",
            ],
            color=GREEN,
            width=5.25,
            height=3.8,
            title_size=22,
            body_size=19,
        )
        pair = VGroup(ppo, grpo).arrange(RIGHT, buff=0.75)
        pair.move_to(DOWN * 0.10)
        takeaway = self.conclusion(
            "PPO asks a critic what was expected; GRPO asks how sibling responses performed."
        )
        self.reveal(heading)
        self.play(
            FadeIn(ppo, shift=RIGHT * 0.10),
            FadeIn(grpo, shift=LEFT * 0.10),
            run_time=1.25,
        )
        self.reveal(takeaway)
        self.hold(4.0)
        self.wipe()

    def _gradient_update(self) -> None:
        heading = self.heading(
            "Gradient update",
            "Definitions",
            subtitle="The objective defines what should improve; the gradient points toward a local parameter change.",
        )
        loss = node("objective / loss  L(θ)\nnumber to optimize", color=AMBER, width=3.1, height=1.2, size=19)
        gradient = node("gradient  ∇θL\nlocal slope for each weight", color=CORAL, width=3.1, height=1.2, size=19)
        update = node("θ′ = θ − α∇θL\nα = learning rate", color=CYAN, width=3.1, height=1.2, size=19)
        flow = VGroup(loss, gradient, update).arrange(RIGHT, buff=0.75)
        flow.move_to(UP * 0.55)
        arrows = VGroup(
            arrow_between(loss, gradient, color=CORAL),
            arrow_between(gradient, update, color=CYAN),
        )
        distinction = VGroup(
            pill("backpropagation computes ∇θL", CORAL, width=3.3),
            pill("the RL rule decides which actions receive credit", GREEN, width=4.2),
        ).arrange(DOWN, buff=0.30)
        distinction.move_to(DOWN * 1.25)
        takeaway = self.conclusion(
            "Policy gradient means the loss contains log action probability weighted by advantage."
        )
        self.reveal(heading, loss)
        self.play(ShowCreation(arrows[0]), FadeIn(gradient), run_time=0.8)
        self.play(ShowCreation(arrows[1]), FadeIn(update), run_time=0.8)
        self.reveal(distinction, run_time=0.6)
        self.reveal(takeaway, run_time=0.55)
        self.hold(3.8)
        self.wipe()

    def _policy_ratio(self) -> None:
        heading = self.heading(
            "Policy ratio",
            "Definitions",
            subtitle="PPO and GRPO compare the current probability with the probability recorded during rollout.",
        )
        old = node("behavior policy  μ\nrecorded probability 0.10", color=VIOLET, width=3.25, height=1.25, size=19)
        ratio = node("ρₜ = πθ(aₜ|sₜ) / μ(aₜ|sₜ)\n0.13 / 0.10 = 1.30", color=CYAN, width=4.0, height=1.25, size=19)
        clipped = node("clip(ρₜ, 1−ε, 1+ε)\nε = update limit", color=AMBER, width=3.25, height=1.25, size=19)
        flow = VGroup(old, ratio, clipped).arrange(RIGHT, buff=0.55)
        flow.move_to(UP * 0.55)
        arrows = VGroup(
            arrow_between(old, ratio, color=CYAN),
            arrow_between(ratio, clipped, color=AMBER),
        )
        cases = VGroup(
            pill("ρ = 1 · unchanged probability", MUTED, width=2.75),
            pill("ρ > 1 · action became more likely", GREEN, width=3.15),
            pill("ρ < 1 · action became less likely", CORAL, width=3.15),
        ).arrange(RIGHT, buff=0.32)
        cases.move_to(DOWN * 1.15)
        takeaway = self.conclusion(
            "Clipping limits one local incentive; it is not a guarantee that the entire policy stayed close."
        )
        self.reveal(heading, old)
        self.play(ShowCreation(arrows[0]), FadeIn(ratio), run_time=0.85)
        self.play(ShowCreation(arrows[1]), FadeIn(clipped), run_time=0.85)
        self.reveal(cases, takeaway, run_time=0.6)
        self.hold(3.9)
        self.wipe()

    def _distribution_terms(self) -> None:
        heading = self.heading(
            "Distribution terms",
            "Definitions",
            subtitle="These quantities describe uncertainty, distance, and teacher–student matching.",
        )
        entropy = panel(
            "ENTROPY  H(π)",
            ["spread of one policy", "high = many plausible actions", "low = concentrated behavior"],
            color=GREEN,
            width=3.7,
            height=3.35,
            title_size=22,
            body_size=18,
        )
        kl = panel(
            "KL DIVERGENCE  DKL",
            ["distance-like shift measure", "compares two distributions", "direction matters"],
            color=AMBER,
            width=3.7,
            height=3.35,
            title_size=21,
            body_size=18,
        )
        cross_entropy = panel(
            "CROSS-ENTROPY  H(q,p)",
            ["teacher target q", "student distribution p", "−Σ qᵢ log pᵢ"],
            color=VIOLET,
            width=3.7,
            height=3.35,
            title_size=20,
            body_size=18,
        )
        cards = VGroup(entropy, kl, cross_entropy).arrange(RIGHT, buff=0.48)
        cards.move_to(DOWN * 0.05)
        takeaway = self.conclusion(
            "Entropy measures spread within one policy; KL and cross-entropy compare distributions."
        )
        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(card, shift=UP * 0.08) for card in cards], lag_ratio=0.14),
            run_time=1.35,
        )
        self.reveal(takeaway)
        self.hold(3.9)
        self.wipe()

    def _rl_acronyms(self) -> None:
        heading = self.heading(
            "RL acronyms",
            "Definitions",
            subtitle="Some names describe a training setting; others describe an update rule or estimator.",
        )
        left = panel(
            "TRAINING SETTING",
            [
                "RL · Reinforcement Learning",
                "RFT · Reinforcement Fine-Tuning",
                "RLVR · RL with Verifiable Rewards",
                "on-policy · learner-generated data",
                "off-policy · other-source data",
            ],
            color=GREEN,
            width=5.55,
            height=4.35,
            title_size=22,
            body_size=18,
        )
        right = panel(
            "UPDATE AND ESTIMATION",
            [
                "PPO · Proximal Policy Optimization",
                "GRPO · Group Relative Policy Optimization",
                "GAE · Generalized Advantage Estimation",
                "pass@k · success within k samples",
                "verifier · reproducible reward rule",
            ],
            color=CYAN,
            width=5.55,
            height=4.35,
            title_size=22,
            body_size=17,
        )
        pair = VGroup(left, right).arrange(RIGHT, buff=0.70)
        pair.move_to(DOWN * 0.10)
        self.reveal(heading)
        self.play(FadeIn(left, shift=RIGHT * 0.10), FadeIn(right, shift=LEFT * 0.10), run_time=1.25)
        self.hold(4.2)
        self.wipe()

    def _teacher_acronyms(self) -> None:
        heading = self.heading(
            "Teacher acronyms",
            "Definitions",
            subtitle="These methods differ by what evidence the frozen teacher receives at the student's current prefix.",
        )
        methods = VGroup(
            panel(
                "OPSD",
                ["On-Policy Self-Distillation", "teacher sees a trusted solution", "student supplies the prefix"],
                color=VIOLET,
                width=3.65,
                height=3.35,
                title_size=25,
                body_size=17,
            ),
            panel(
                "SDFT",
                ["Self-Distillation Fine-Tuning", "teacher sees a demonstration", "student supplies the prefix"],
                color=BLUE,
                width=3.65,
                height=3.35,
                title_size=25,
                body_size=17,
            ),
            panel(
                "SDPO",
                ["Self-Distillation Policy Optimization", "teacher sees failure feedback", "student supplies the prefix"],
                color=CORAL,
                width=3.65,
                height=3.35,
                title_size=25,
                body_size=17,
            ),
        ).arrange(RIGHT, buff=0.48)
        methods.move_to(DOWN * 0.05)
        srpo = pill(
            "SRPO · Self-Rewarding Policy Optimization · routes success and failure differently",
            AMBER,
            width=7.4,
        )
        srpo.next_to(methods, DOWN, buff=0.32)
        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(method, shift=UP * 0.08) for method in methods], lag_ratio=0.15),
            run_time=1.35,
        )
        self.reveal(srpo)
        self.hold(4.3)
        self.wipe()
