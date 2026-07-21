"""Chapter 3: trajectories, reward, advantages, credit, entropy, and KL."""

from manimlib import *

from components import (
    BarDatum,
    arrow_between,
    bar_chart,
    callout,
    line_graph,
    node,
    panel,
    pill,
    plot_frame,
    text,
)
from course_base import LessonScene
from theme import AMBER, BLUE, CORAL, CYAN, GREEN, GRID, INK, MUTED, VIOLET


class Chapter03RLSignals(LessonScene):
    chapter_number = 4
    chapter_color = AMBER

    def construct(self) -> None:
        self.lesson_intro(
            "Rewards and credit assignment",
            "How an outcome becomes credit for earlier actions.",
        )
        self._trajectory()
        self._trajectory_record_math()
        self._reward_vs_feedback()
        self._credit_assignment()
        self._discounted_return()
        self._advantage()
        self._policy_update()
        self._exploration()
        self._reference_kl()

    def _trajectory(self) -> None:
        heading = self.heading(
            "The patch has a history",
            "From outcomes to credit",
            subtitle="Before tests passed, the policy inspected files, read observations, and wrote the repair.",
        )
        issue = node(
            "State s₀\nissue + repository",
            color=BLUE,
            width=2.25,
            height=1.1,
        )
        inspect = node(
            "a₀ ∼ μ(·|s₀)\ninspect files",
            color=CYAN,
            width=2.15,
            height=1.1,
            size=18,
        )
        state = node("State s₁\nfile contents", color=BLUE, width=2.0, height=1.1)
        patch = node(
            "a₁ ∼ μ(·|s₁)\nraise CancelledError()",
            color=CYAN,
            width=2.15,
            height=1.1,
            size=18,
        )
        terminal = node("Terminal state\nrun tests", color=GREEN, width=2.0, height=1.1)
        flow = VGroup(issue, inspect, state, patch, terminal)
        flow.arrange(RIGHT, buff=0.38).move_to(UP * 0.35)
        arrows = VGroup(
            *[
                arrow_between(flow[index], flow[index + 1])
                for index in range(len(flow) - 1)
            ]
        )
        labels = VGroup(
            pill("sample action", CYAN, width=1.55),
            pill("tool output", MUTED, width=1.4),
            pill("sample action", CYAN, width=1.55),
            pill("test result", GREEN, width=1.45),
        )
        for label, arrow in zip(labels, arrows):
            label.next_to(arrow, UP, buff=0.08)
        definition = self.conclusion(
            "τ stores states, sampled actions, behavior log-probabilities, observations, and final reward."
        )
        self.reveal(heading, issue)
        for index, arrow in enumerate(arrows):
            self.play(
                ShowCreation(arrow),
                FadeIn(labels[index]),
                FadeIn(flow[index + 1]),
                run_time=0.72,
            )
        self.reveal(definition)
        self.source(
            "τ = (s₀, a₀, log μ(a₀|s₀), o₁, a₁, …, r)",
            label="TRAJECTORY RECORD",
        )
        self.hold(4.0)
        self.wipe()

    def _trajectory_record_math(self) -> None:
        heading = self.heading(
            "Trajectory anatomy",
            "RL signals",
            subtitle="Only sampled actions receive policy-gradient terms; observations become later state.",
        )
        term_specs = [
            ("s₀", "state", BLUE),
            ("a₀", "sampled action", CYAN),
            ("log μ₀", "behavior logp", VIOLET),
            ("o₁", "observation", GREEN),
            ("s₁", "next state", BLUE),
            ("a₁", "sampled action", CYAN),
            ("rT", "terminal reward", AMBER),
        ]
        terms = VGroup(
            *[
                node(
                    f"{symbol}\n{meaning}",
                    color=color,
                    width=1.65 if index not in [2, 6] else 1.9,
                    height=1.15,
                    size=17,
                )
                for index, (symbol, meaning, color) in enumerate(term_specs)
            ]
        ).arrange(RIGHT, buff=0.18)
        terms.move_to(UP * 0.55)
        commas = VGroup(
            *[
                text(",", size=28, color=MUTED, weight="BOLD")
                for _ in range(len(terms) - 1)
            ]
        )
        for comma, left, right in zip(commas, terms[:-1], terms[1:]):
            comma.move_to((left.get_right() + right.get_left()) / 2)
        tuple_label = text(
            "τ  =  ( s₀, a₀, log μ(a₀|s₀), o₁, s₁, a₁, …, rT )",
            size=29,
            color=INK,
            weight="BOLD",
        )
        tuple_label.move_to(DOWN * 0.7)
        masks = VGroup(
            pill("gradient terms: a₀, a₁, …", CYAN, width=2.75),
            pill("conditioning evidence: s, o", GREEN, width=2.75),
            pill("provenance: μ log-probs", VIOLET, width=2.75),
        ).arrange(RIGHT, buff=0.30)
        masks.next_to(tuple_label, DOWN, buff=0.40)
        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(term) for term in terms], lag_ratio=0.08),
            FadeIn(commas),
            run_time=1.25,
        )
        self.play(TransformFromCopy(terms, tuple_label), run_time=0.8)
        self.reveal(masks, run_time=0.5)
        self.hold(1.25)
        self.wipe()

    def _reward_vs_feedback(self) -> None:
        heading = self.heading(
            "Reward versus feedback",
            "RL signals",
            subtitle="Reward says how well; feedback may explain what happened.",
        )
        attempt = panel(
            "PATCH ATTEMPT",
            [
                "edits retry.py",
                "adds a timeout branch",
                "forgets cancellation",
            ],
            width=3.2,
            height=3.0,
            color=BLUE,
            body_size=19,
        )
        tests = panel(
            "ENVIRONMENT FEEDBACK",
            [
                "8 tests passed",
                "test_cancel failed",
                "expected CancelledError",
            ],
            width=4.1,
            height=3.0,
            color=GREEN,
            body_size=19,
        )
        reward = panel(
            "REWARD",
            [
                "0",
                "one scalar",
                "used by the objective",
            ],
            width=2.8,
            height=3.0,
            color=AMBER,
            body_size=19,
        )
        flow = VGroup(attempt, tests, reward).arrange(RIGHT, buff=0.55)
        flow.move_to(DOWN * 0.15)
        arrows = VGroup(arrow_between(attempt, tests), arrow_between(tests, reward))
        self.reveal(heading, attempt)
        self.play(ShowCreation(arrows[0]), FadeIn(tests), run_time=1.0)
        self.play(ShowCreation(arrows[1]), FadeIn(reward), run_time=1.0)
        note = self.conclusion(
            "Throwing away the failure trace makes the learning signal much poorer."
        )
        self.reveal(note)
        self.source("Illustrative unit-test environment", label="WORKED EXAMPLE")
        self.hold(4.0)
        self.wipe()

    def _credit_assignment(self) -> None:
        heading = self.heading(
            "Where credit goes",
            "RL signals",
            subtitle="A final score arrives after hundreds or thousands of token decisions.",
        )
        tokens = [
            "inspect",
            "retry.py",
            "edit",
            "timeout",
            "return",
            "None",
            "run",
            "tests",
        ]
        token_nodes = VGroup(
            *[
                node(token, width=1.25, height=0.72, size=17)
                for token in tokens
            ]
        ).arrange(RIGHT, buff=0.16)
        token_nodes.move_to(UP * 0.55)
        reward = pill("terminal reward = 0", CORAL, width=2.35)
        reward.next_to(token_nodes, DOWN, buff=0.65)
        arrows = VGroup(
            *[
                Arrow(
                    reward.get_top(),
                    token_node.get_bottom(),
                    buff=0.08,
                    color=MUTED if index != 5 else CORAL,
                    stroke_width=2 if index != 5 else 4,
                    tip_width_ratio=4,
                )
                for index, token_node in enumerate(token_nodes)
            ]
        )
        levels = VGroup(
            pill("response-level: one score", MUTED, width=2.7),
            pill("step-level: inspect / edit / test", MUTED, width=3.2),
            pill("token-level: each sampled token", MUTED, width=3.0),
        ).arrange(RIGHT, buff=0.32)
        levels.to_edge(DOWN, buff=1.05)
        self.reveal(heading, token_nodes, reward)
        self.play(
            LaggedStart(*[ShowCreation(arrow) for arrow in arrows], lag_ratio=0.08),
            run_time=1.6,
        )
        self.reveal(levels)
        self.source("The true causal contribution of each token is unobserved", label="CREDIT PROBLEM")
        self.hold(4.2)
        self.wipe()

    def _advantage(self) -> None:
        heading = self.heading(
            "Advantage",
            "RL signals",
            subtitle="A baseline turns an absolute score into a relative learning signal.",
        )
        values = VGroup(
            panel(
                "OBSERVED RETURN",
                ["G = 0.8", "discounted future reward"],
                width=3.2,
                height=2.3,
                color=GREEN,
                body_size=20,
            ),
            panel(
                "EXPECTED REWARD",
                ["b = 0.5", "baseline for this prompt"],
                width=3.2,
                height=2.3,
                color=BLUE,
                body_size=20,
            ),
            panel(
                "ADVANTAGE",
                ["A = G − b = +0.3", "increase its probability"],
                width=3.5,
                height=2.3,
                color=AMBER,
                body_size=20,
            ),
        ).arrange(RIGHT, buff=0.55)
        values.move_to(UP * 0.2)
        minus = text("−", size=38, color=MUTED, weight="BOLD")
        equals = text("=", size=38, color=MUTED, weight="BOLD")
        minus.move_to((values[0].get_right() + values[1].get_left()) / 2)
        equals.move_to((values[1].get_right() + values[2].get_left()) / 2)
        counter = callout(
            "If G = 0.2 with the same baseline, A = −0.3: decrease its probability.",
            width=10.7,
            size=22,
        )
        counter.to_edge(DOWN, buff=0.78)
        self.reveal(heading, values[0])
        self.play(FadeIn(minus), FadeIn(values[1]), run_time=0.8)
        self.play(FadeIn(equals), FadeIn(values[2]), run_time=0.8)
        self.reveal(counter)
        self.source("A = return − baseline · simplified one-step example", label="WORKED EXAMPLE")
        self.hold(4.2)
        self.wipe()

    def _discounted_return(self) -> None:
        heading = self.heading(
            "Discounted return",
            "RL signals",
            subtitle="Discounting makes nearby outcomes count more than distant ones.",
        )
        rewards = VGroup(
            node("rₜ = 0\nweight 1", color=MUTED, width=2.0, height=1.15, size=19),
            node("rₜ₊₁ = 0\nweight γ", color=MUTED, width=2.0, height=1.15, size=19),
            node("rₜ₊₂ = 1\nweight γ²", color=GREEN, width=2.0, height=1.15, size=19),
        ).arrange(RIGHT, buff=0.85)
        rewards.move_to(UP * 0.75)
        arrows = VGroup(
            arrow_between(rewards[0], rewards[1]),
            arrow_between(rewards[1], rewards[2]),
        )
        equation = text(
            "Gₜ = Σₖ γᵏ rₜ₊ₖ",
            size=33,
            color=INK,
            weight="BOLD",
        )
        equation.move_to(DOWN * 0.55)
        example = text(
            "γ = 0.9   ⇒   Gₜ = 0 + 0.9·0 + 0.9²·1 = 0.81",
            size=26,
            color=AMBER,
            weight="BOLD",
        )
        example.next_to(equation, DOWN, buff=0.35)
        applies = VGroup(
            pill("PPO critics · multi-step agent RL", VIOLET, width=3.75),
            pill("GAE = Generalized Advantage Estimation", AMBER, width=4.45),
        ).arrange(RIGHT, buff=0.28)
        applies.next_to(example, DOWN, buff=0.30)
        self.reveal(heading, rewards[0])
        self.play(
            ShowCreation(arrows[0]),
            FadeIn(rewards[1]),
            ShowCreation(arrows[1]),
            FadeIn(rewards[2]),
            run_time=0.95,
        )
        self.reveal(equation, example, applies, run_time=0.65)
        self.hold(1.35)
        self.wipe()

    def _policy_update(self) -> None:
        heading = self.heading(
            "Probability after credit",
            "RL signals",
            subtitle="Positive advantage pushes up; negative advantage pushes down.",
        )
        before = bar_chart(
            [
                BarDatum("safe patch", 18, GREEN),
                BarDatum("quick patch", 52, BLUE),
                BarDatum("abstain", 30, CORAL),
            ],
            max_value=60,
            width=4.7,
            height=3.45,
            value_suffix="%",
            value_decimals=0,
        )
        after = bar_chart(
            [
                BarDatum("safe patch", 31, GREEN),
                BarDatum("quick patch", 43, MUTED),
                BarDatum("abstain", 26, CORAL),
            ],
            max_value=60,
            width=4.7,
            height=3.45,
            value_suffix="%",
            value_decimals=0,
        )
        before.move_to(LEFT * 3.0 + DOWN * 0.05)
        after.move_to(RIGHT * 3.0 + DOWN * 0.05)
        before_label = text("BEFORE UPDATE", size=18, color=MUTED, weight="BOLD")
        after_label = text("AFTER POSITIVE ADVANTAGE", size=18, color=INK, weight="BOLD")
        before_label.next_to(before, UP, buff=0.15)
        after_label.next_to(after, UP, buff=0.15)
        arrow = Arrow(
            before.get_right(),
            after.get_left(),
            color=GREEN,
            buff=0.25,
            stroke_width=4,
        )
        self.reveal(heading, before, before_label)
        self.play(ShowCreation(arrow), FadeIn(after), FadeIn(after_label), run_time=1.5)
        note = self.conclusion(
            "Policy gradient does not edit one answer; it shifts the distribution that produces future answers."
        )
        self.reveal(note)
        self.source("Illustrative policy-gradient effect", label="CONCEPTUAL")
        self.hold(4.0)
        self.wipe()

    def _exploration(self) -> None:
        heading = self.heading(
            "Exploration and collapse",
            "RL signals",
            subtitle="Entropy measures how spread out the policy distribution is.",
        )
        frame = plot_frame(
            x_label="TRAINING",
            y_label="DIVERSITY / SUCCESS",
            width=9.3,
            height=4.0,
        )
        frame.group.shift(DOWN * 0.35)
        frame.origin += DOWN * 0.35
        pass1 = line_graph(
            frame,
            [(0, 0.18), (0.2, 0.31), (0.4, 0.46), (0.6, 0.57), (0.8, 0.64), (1, 0.69)],
            color=INK,
            stroke_width=5,
        )
        diversity = line_graph(
            frame,
            [(0, 0.85), (0.2, 0.75), (0.4, 0.58), (0.6, 0.40), (0.8, 0.25), (1, 0.14)],
            color=BLUE,
            stroke_width=4,
        )
        pass_label = pill("pass@1", GREEN, width=1.3)
        diversity_label = pill("entropy / diversity", BLUE, width=2.2)
        pass_label.move_to(frame.point(0.84, 0.72))
        diversity_label.move_to(frame.point(0.78, 0.24))
        warning = pill("collapse risk", CORAL, width=1.65)
        warning.move_to(frame.point(0.92, 0.07))
        self.reveal(heading, frame.group)
        self.play(ShowCreation(pass1), FadeIn(pass_label), run_time=1.4)
        self.play(
            ShowCreation(diversity),
            FadeIn(diversity_label),
            FadeIn(warning),
            run_time=1.4,
        )
        self.source(
            "Conceptual curves · measure both pass@1 and pass@k",
            label="EXPLORATION",
        )
        self.hold(4.2)
        self.wipe()

    def _reference_kl(self) -> None:
        heading = self.heading(
            "Reference-policy drift",
            "RL signals",
            subtitle="A frozen reference policy makes change measurable.",
        )
        current = panel(
            "CURRENT POLICY  πθ",
            [
                "being optimized",
                "may exploit the reward",
                "changes every update",
            ],
            width=4.2,
            height=3.15,
            color=AMBER,
            body_size=20,
        )
        reference = panel(
            "REFERENCE  πref",
            [
                "frozen checkpoint",
                "anchors prior behavior",
                "supports retention checks",
            ],
            width=4.2,
            height=3.15,
            color=BLUE,
            body_size=20,
        )
        pair = VGroup(current, reference).arrange(RIGHT, buff=1.35)
        pair.move_to(DOWN * 0.05)
        bridge = VGroup(
            Arrow(
                current.get_right() + UP * 0.10,
                reference.get_left() + UP * 0.10,
                buff=0.18,
                color=AMBER,
                stroke_width=3,
            ),
            Arrow(
                reference.get_left() + DOWN * 0.10,
                current.get_right() + DOWN * 0.10,
                buff=0.18,
                color=BLUE,
                stroke_width=3,
            ),
        )
        kl = pill(
            "KL = Kullback–Leibler divergence · distribution shift",
            VIOLET,
            width=5.6,
        )
        kl.next_to(bridge, UP, buff=0.22)
        tradeoff = self.conclusion(
            "Too little constraint can cause drift; too much can prevent learning."
        )
        self.reveal(heading, current, reference)
        self.play(ShowCreation(bridge), FadeIn(kl), run_time=1.2)
        self.reveal(tradeoff)
        self.source("Reference-policy regularization in RLHF and RFT", label="STABILITY")
        self.hold(4.0)
        self.wipe()
