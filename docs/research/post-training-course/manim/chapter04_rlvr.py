"""Chapter 4: reinforcement learning with verifiable rewards."""

from manimlib import *

from components import (
    BarDatum,
    arrow_between,
    bar_chart,
    callout,
    node,
    panel,
    pill,
    text,
)
from course_base import LessonScene
from theme import AMBER, BLUE, CORAL, CYAN, GREEN, GRID, INK, MUTED, SURFACE_2, VIOLET


class Chapter04RLVR(LessonScene):
    chapter_number = 5
    chapter_color = GREEN

    def construct(self) -> None:
        self.lesson_intro(
            "Verifiable rewards",
            "When tests and checkers can score model behavior automatically.",
        )
        self._definition()
        self._verifier_equation()
        self._verifier_loop()
        self._use_cases()
        self._errors()
        self._reward_hacking()
        self._hidden_tests()
        self._not_an_optimizer()

    def _definition(self) -> None:
        heading = self.heading(
            "Can we trust the test?",
            "Reinforcement learning with verifiable rewards",
            subtitle="The same cancellation patch can be judged subjectively or checked by execution.",
        )
        preference = panel(
            "PREFERENCE FEEDBACK",
            [
                "“response A is clearer”",
                "subjective or model-judged",
                "can vary by evaluator",
            ],
            width=4.8,
            height=3.3,
            color=VIOLET,
            body_size=20,
        )
        verifiable = panel(
            "VERIFIABLE REWARD",
            [
                "“all hidden tests pass”",
                "rule-based or executable",
                "same answer → same result",
            ],
            width=4.8,
            height=3.3,
            color=GREEN,
            body_size=20,
        )
        pair = VGroup(preference, verifiable).arrange(RIGHT, buff=0.8)
        pair.move_to(DOWN * 0.12)
        label = self.conclusion(
            "RLVR = reinforcement learning with verifiable rewards."
        )
        self.reveal(heading)
        self.play(
            FadeIn(preference, shift=RIGHT * 0.12),
            FadeIn(verifiable, shift=LEFT * 0.12),
            run_time=1.4,
        )
        self.reveal(label)
        self.source("DeepSeek-R1 · arXiv:2501.12948", label="SETTING")
        self.hold(4.2)
        self.wipe()

    def _verifier_equation(self) -> None:
        heading = self.heading(
            "The verifier",
            "RLVR",
            subtitle="The reward function can inspect artifacts and environment state that the policy cannot see.",
        )
        prompt = node("Task x\nfix cancellation", color=BLUE, width=2.35, height=1.15)
        attempt = node("Attempt y\nraise CancelledError", color=CYAN, width=2.35, height=1.15)
        environment = node(
            "Evaluator state e\nhidden tests",
            color=VIOLET,
            width=2.35,
            height=1.15,
        )
        inputs = VGroup(prompt, attempt, environment).arrange(RIGHT, buff=0.45)
        inputs.move_to(UP * 0.85)
        arrows = VGroup(
            *[
                Arrow(
                    item.get_bottom(),
                    DOWN * 0.45 + RIGHT * 0.0,
                    color=item[1].get_color(),
                    buff=0.15,
                    stroke_width=3,
                )
                for item in inputs
            ]
        )
        equation = text(
            "r = V(x, y, e) ∈ {0, 1}",
            size=36,
            color=GREEN,
            weight="BOLD",
        )
        equation.move_to(DOWN * 0.55)
        outputs = VGroup(
            pill("1 · verified success", GREEN, width=2.35),
            pill("0 · failed verification", CORAL, width=2.55),
        ).arrange(RIGHT, buff=0.35)
        outputs.next_to(equation, DOWN, buff=0.38)
        bridge = pill(
            "RLVR supplies r; a policy optimizer supplies the update",
            AMBER,
            width=6.0,
        )
        bridge.next_to(outputs, DOWN, buff=0.30)
        paper = pill("DEEPSEEK-R1 · RLVR AT SCALE · 2025", MUTED, width=3.75)
        paper.next_to(equation, UP, buff=0.35)
        self.reveal(heading, inputs)
        self.play(
            LaggedStart(*[ShowCreation(arrow) for arrow in arrows], lag_ratio=0.10),
            run_time=0.9,
        )
        self.reveal(paper, equation, outputs, bridge, run_time=0.65)
        self.hold(1.25)
        self.wipe()

    def _verifier_loop(self) -> None:
        heading = self.heading(
            "The RLVR loop",
            "RLVR",
            subtitle="The environment closes the loop without a human rating every sample.",
        )
        prompt = node("Cancellation issue\n+ repository", color=BLUE, width=2.2, height=1.05, size=18)
        policy = node(
            "Policy samples\nan attempt",
            color=CYAN,
            width=2.2,
            height=1.05,
        )
        execute = node(
            "Apply patch\nrun tests",
            color=AMBER,
            width=2.2,
            height=1.05,
        )
        verify = node(
            "Verifier\nchecks outcome",
            color=GREEN,
            width=2.2,
            height=1.05,
        )
        reward = node("Reward\n0 / 1", color=GREEN, width=1.7, height=1.05)
        flow = VGroup(prompt, policy, execute, verify, reward)
        flow.arrange(RIGHT, buff=0.38).move_to(UP * 0.5)
        arrows = VGroup(
            *[
                arrow_between(flow[index], flow[index + 1])
                for index in range(len(flow) - 1)
            ]
        )
        update = node("Update πθ", color=VIOLET, width=1.8)
        update.move_to(DOWN * 1.25 + RIGHT * 2.2)
        update_arrow = CurvedArrow(
            reward.get_bottom(),
            update.get_right(),
            angle=-PI / 4,
            color=GREEN,
            stroke_width=3,
        )
        loop_arrow = CurvedArrow(
            update.get_left(),
            policy.get_bottom(),
            angle=-PI / 3,
            color=MUTED,
            stroke_width=3,
        )
        self.reveal(heading, prompt)
        for index, arrow in enumerate(arrows):
            self.play(ShowCreation(arrow), FadeIn(flow[index + 1]), run_time=0.7)
        self.play(
            ShowCreation(update_arrow),
            FadeIn(update),
            ShowCreation(loop_arrow),
            run_time=1.2,
        )
        self.source("Outcome-reward training loop", label="RLVR LOOP")
        self.hold(4.0)
        self.wipe()

    def _use_cases(self) -> None:
        heading = self.heading(
            "RLVR applies to",
            "RLVR",
            subtitle="Use it when success can be checked reproducibly without subjective judgment.",
        )
        cases = VGroup(
            panel(
                "MATH",
                ["exact or equivalent answer", "symbolic checker", "proof assistant"],
                width=3.55,
                height=2.35,
                color=INK,
                body_size=18,
            ),
            panel(
                "CODE",
                ["unit and integration tests", "compiler / runtime", "performance limit"],
                width=3.55,
                height=2.35,
                color=INK,
                body_size=18,
            ),
            panel(
                "TOOLS",
                ["API reaches target state", "schema validates", "transaction succeeds"],
                width=3.55,
                height=2.35,
                color=INK,
                body_size=18,
            ),
            panel(
                "SEARCH",
                ["retrieves needed evidence", "answer contains target fact", "citation resolves"],
                width=3.55,
                height=2.35,
                color=INK,
                body_size=18,
            ),
            panel(
                "SCIENCE",
                ["simulator objective", "constraint satisfaction", "formal calculation"],
                width=3.55,
                height=2.35,
                color=INK,
                body_size=18,
            ),
            panel(
                "GAMES / CONTROL",
                ["score or terminal state", "safety constraints", "resource budget"],
                width=3.55,
                height=2.35,
                color=INK,
                body_size=18,
            ),
        )
        cases.arrange_in_grid(n_rows=2, n_cols=3, h_buff=0.35, v_buff=0.35)
        cases.move_to(DOWN * 0.35)
        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(card) for card in cases], lag_ratio=0.1),
            run_time=1.8,
        )
        poor_fit = self.conclusion(
            "Poor fit: subjective quality, unverifiable outcomes, or a checker the policy can easily game."
        )
        self.reveal(poor_fit)
        self.source(
            "DeepSeek-R1 · Search-R1 (2503.09516) · SWE-RL (2502.18449)",
            label="REAL SETTINGS",
        )
        self.hold(4.5)
        self.wipe()

    def _errors(self) -> None:
        heading = self.heading(
            "Verifier errors",
            "RLVR",
            subtitle="Optimization follows the measured task rather than the intended task.",
        )
        header = VGroup(
            text("ACTUALLY CORRECT", size=18, color=INK, weight="BOLD"),
            text("ACTUALLY WRONG", size=18, color=INK, weight="BOLD"),
        ).arrange(RIGHT, buff=2.8)
        row_labels = VGroup(
            text("VERIFIER ACCEPTS", size=18, color=INK, weight="BOLD"),
            text("VERIFIER REJECTS", size=18, color=INK, weight="BOLD"),
        ).arrange(DOWN, buff=1.25)
        good = panel(
            "TRUE POSITIVE",
            ["correct solution", "accepted"],
            width=3.15,
            height=1.55,
            color=GREEN,
            body_size=17,
        )
        false_pos = panel(
            "FALSE POSITIVE",
            ["wrong solution", "reward exploit"],
            width=3.15,
            height=1.55,
            color=CORAL,
            body_size=17,
        )
        false_neg = panel(
            "FALSE NEGATIVE",
            ["valid solution", "checker misses it"],
            width=3.15,
            height=1.55,
            color=AMBER,
            body_size=17,
        )
        reject = panel(
            "TRUE NEGATIVE",
            ["wrong solution", "rejected"],
            width=3.15,
            height=1.55,
            color=MUTED,
            body_size=17,
        )
        matrix = VGroup(good, false_pos, false_neg, reject)
        matrix.arrange_in_grid(n_rows=2, n_cols=2, h_buff=0.35, v_buff=0.3)
        matrix.move_to(RIGHT * 1.1 + DOWN * 0.35)
        header.next_to(matrix, UP, buff=0.25)
        row_labels.next_to(matrix, LEFT, buff=0.3)
        self.reveal(heading, header, row_labels)
        self.play(
            LaggedStart(*[FadeIn(cell) for cell in matrix], lag_ratio=0.16),
            run_time=1.5,
        )
        self.source("Verifier confusion matrix", label="VALIDATION")
        self.hold(4.2)
        self.wipe()

    def _reward_hacking(self) -> None:
        heading = self.heading(
            "Reward hacking",
            "RLVR",
            subtitle="The easiest exploit often becomes more likely than the intended skill.",
        )
        intended = panel(
            "INTENDED BEHAVIOR",
            [
                "repair cancellation logic",
                "preserve public API",
                "pass unseen scenarios",
            ],
            width=4.1,
            height=3.1,
            color=GREEN,
            body_size=20,
        )
        exploit = panel(
            "POSSIBLE EXPLOIT",
            [
                "skip the failing test",
                "hard-code visible inputs",
                "return success without work",
            ],
            width=4.1,
            height=3.1,
            color=CORAL,
            body_size=20,
        )
        score = bar_chart(
            [
                BarDatum("real fix", 1.0, GREEN),
                BarDatum("exploit", 1.0, CORAL),
            ],
            max_value=1.1,
            width=2.8,
            height=2.7,
            value_decimals=1,
        )
        group = VGroup(intended, score, exploit).arrange(RIGHT, buff=0.45)
        group.move_to(DOWN * 0.08)
        self.reveal(heading, intended, exploit)
        self.play(FadeIn(score, shift=UP * 0.1), run_time=1.2)
        lesson = self.conclusion(
            "Equal rewards make the intended behavior and the exploit indistinguishable to the objective."
        )
        self.reveal(lesson)
        self.source("Illustrative specification gaming", label="FAILURE MODE")
        self.hold(4.2)
        self.wipe()

    def _hidden_tests(self) -> None:
        heading = self.heading(
            "Hidden evaluation",
            "RLVR",
            subtitle="A strong task design makes shortcut information unavailable.",
        )
        visible = panel(
            "POLICY-VISIBLE",
            [
                "task statement",
                "public examples",
                "tool observations",
                "allowed files",
            ],
            width=4.4,
            height=3.5,
            color=BLUE,
            body_size=20,
        )
        hidden = panel(
            "EVALUATOR-ONLY",
            [
                "held-out tests",
                "edge cases",
                "anti-cheat checks",
                "independent seed",
            ],
            width=4.4,
            height=3.5,
            color=VIOLET,
            body_size=20,
        )
        barrier = DashedLine(UP * 2.0, DOWN * 2.0, color=MUTED, stroke_width=2)
        barrier_label = pill("information boundary", MUTED, width=2.2)
        barrier_label.next_to(barrier, UP, buff=0.16)
        layout = VGroup(visible, VGroup(barrier, barrier_label), hidden)
        layout.arrange(RIGHT, buff=0.75).move_to(DOWN * 0.15)
        self.reveal(heading, visible)
        self.play(ShowCreation(barrier), FadeIn(barrier_label), FadeIn(hidden), run_time=1.2)
        self.source("Training/evaluation isolation for executable tasks", label="DATA DESIGN")
        self.hold(4.2)
        self.wipe()

    def _not_an_optimizer(self) -> None:
        heading = self.heading(
            "Reward versus optimizer",
            "RLVR",
        )
        setting = node("Verifiable\nenvironment", color=GREEN, width=2.4, height=1.2)
        reward = node("Outcome reward", color=GREEN, width=2.15)
        optimizers = VGroup(
            pill("PPO · learned critic", MUTED, width=2.45),
            pill("GRPO · group baseline", INK, width=2.65),
            pill("DAPO · GRPO stability changes", MUTED, width=3.35),
            pill("REINFORCE · direct policy gradient", MUTED, width=3.5),
            pill("SDPO · feedback distillation", MUTED, width=3.05),
        ).arrange(DOWN, buff=0.22)
        result = node("Updated policy", color=VIOLET, width=2.2)
        layout = VGroup(setting, reward, optimizers, result)
        layout.arrange(RIGHT, buff=0.75).move_to(DOWN * 0.05)
        arrow1 = arrow_between(setting, reward)
        arrow2 = arrow_between(reward, optimizers)
        arrow3 = arrow_between(optimizers, result)
        self.reveal(heading, setting)
        self.play(ShowCreation(arrow1), FadeIn(reward), run_time=0.8)
        self.play(ShowCreation(arrow2), FadeIn(optimizers), run_time=1.1)
        self.play(ShowCreation(arrow3), FadeIn(result), run_time=0.8)
        close = self.conclusion(
            "“RLVR + GRPO” means verifiable rewards are the setting and GRPO is the update rule."
        )
        self.reveal(close)
        self.source("Setting versus optimizer", label="DISTINCTION")
        self.hold(4.3)
        self.wipe()
