"""Chapter 5: a worked explanation of group relative policy optimization."""

from __future__ import annotations

import numpy as np
from manimlib import *

from components import (
    arrow_between,
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


class Chapter05GRPO(LessonScene):
    chapter_number = 6
    chapter_color = VIOLET

    def construct(self) -> None:
        self.lesson_intro(
            "PPO and GRPO",
            "Two ways to turn rollout outcomes into a controlled policy update.",
        )
        self._ppo_baseline()
        self._group_rollout()
        self._worked_advantages()
        self._probability_ratio()
        self._contrast_graph()
        self._zero_variance()
        self._where_it_fits()

    def _ppo_baseline(self) -> None:
        heading = self.heading(
            "PPO: compare with a critic",
            "PPO paper · 2017",
            subtitle="The cancellation repair scored 0.8; a learned critic expected only 0.5.",
        )
        trajectory = node(
            "Cancellation trajectory\ninspect → patch → test",
            color=BLUE,
            width=2.6,
            height=1.15,
        )
        reward = node("Observed return\nRₜ = 0.8", color=GREEN, width=2.2, height=1.15)
        critic = node(
            "Critic Vψ(sₜ)\nexpected return = 0.5",
            color=CYAN,
            width=2.75,
            height=1.15,
            size=18,
        )
        advantage = node(
            "Advantage\nAₜ = Rₜ − Vψ = +0.3",
            color=AMBER,
            width=2.8,
            height=1.15,
            size=18,
        )
        top = VGroup(trajectory, reward, critic, advantage)
        top.arrange(RIGHT, buff=0.35).move_to(UP * 0.75)
        arrows = VGroup(
            arrow_between(trajectory, reward),
            arrow_between(reward, critic),
            arrow_between(critic, advantage),
        )
        ratio = panel(
            "POLICY RATIO",
            ["ρₜ = πθ(aₜ|sₜ) / πold(aₜ|sₜ)", "measures the update"],
            color=VIOLET,
            width=4.5,
            height=2.0,
            body_size=18,
        )
        objective = panel(
            "CLIPPED PPO OBJECTIVE",
            ["min(ρₜAₜ, clip(ρₜ)Aₜ)", "backpropagate through πθ"],
            color=AMBER,
            width=4.8,
            height=2.0,
            body_size=18,
        )
        lower = VGroup(ratio, objective).arrange(RIGHT, buff=0.6)
        lower.move_to(DOWN * 1.25)
        lower_arrow = arrow_between(ratio, objective)
        self.reveal(heading, trajectory)
        for index, arrow in enumerate(arrows):
            self.play(
                ShowCreation(arrow),
                FadeIn(top[index + 1]),
                run_time=0.7,
            )
        self.reveal(ratio)
        self.play(ShowCreation(lower_arrow), FadeIn(objective), run_time=0.9)
        self.source(
            "Proximal Policy Optimization · Schulman et al. · arXiv:1707.06347",
            label="PAPER MECHANISM",
        )
        self.hold(4.0)
        self.wipe()

    def _group_rollout(self) -> None:
        heading = self.heading(
            "GRPO: compare sibling patches",
            "DeepSeekMath · GRPO · 2024",
            subtitle="Instead of a critic, Group Relative Policy Optimization compares attempts at the same bug.",
        )
        prompt = node("Fix cancellation bug\nreturn None is wrong", width=2.7, height=1.15, size=18)
        prompt.move_to(LEFT * 4.8 + UP * 0.15)
        outputs = [
            ("raise Cancelled", "1"),
            ("return None", "0"),
            ("raise Timeout", "0"),
            ("cancel + raise", "1"),
            ("guard + raise", "1"),
            ("retry loop", "0"),
        ]
        attempts = VGroup(
            *[
                node(
                    f"{answer}\nr = {reward}",
                    color=GREEN if reward == "1" else CORAL,
                    width=2.0,
                    height=0.95,
                    size=18,
                )
                for answer, reward in outputs
            ]
        )
        attempts.arrange_in_grid(n_rows=3, n_cols=2, h_buff=0.3, v_buff=0.28)
        attempts.move_to(RIGHT * 2.25 + UP * 0.1)
        arrows = VGroup(
            *[
                Arrow(
                    prompt.get_right(),
                    attempt.get_left(),
                    buff=0.12,
                    color=MUTED,
                    stroke_width=2.5,
                )
                for attempt in attempts
            ]
        )
        note = self.conclusion(
            "One prompt produces G trajectories; each receives a verifier score."
        )
        self.reveal(heading, prompt)
        self.play(
            LaggedStart(
                *[
                    AnimationGroup(ShowCreation(arrow), FadeIn(attempt))
                    for arrow, attempt in zip(arrows, attempts)
                ],
                lag_ratio=0.12,
            ),
            run_time=1.8,
        )
        self.reveal(note)
        self.source("GRPO introduced in DeepSeekMath · arXiv:2402.03300", label="METHOD")
        self.hold(4.3)
        self.wipe()

    def _worked_advantages(self) -> None:
        heading = self.heading(
            "Group-relative advantage",
            "GRPO",
            subtitle="The same six patch attempts produced three failures and three successes.",
        )
        rewards = [1, 0, 0, 1, 1, 0]
        reward_row = VGroup()
        advantage_row = VGroup()
        for index, reward in enumerate(rewards):
            reward_box = node(
                str(reward),
                color=GREEN if reward else CORAL,
                width=0.9,
                height=0.72,
                size=20,
            )
            advantage_box = node(
                "+1" if reward else "−1",
                color=GREEN if reward else CORAL,
                width=0.9,
                height=0.72,
                size=20,
            )
            reward_row.add(reward_box)
            advantage_row.add(advantage_box)
        reward_row.arrange(RIGHT, buff=0.2).move_to(UP * 1.0)
        advantage_row.arrange(RIGHT, buff=0.2).move_to(DOWN * 1.0)
        reward_label = text("REWARDS", size=18, color=MUTED, weight="BOLD")
        advantage_label = text("NORMALIZED ADVANTAGES", size=18, color=MUTED, weight="BOLD")
        reward_label.next_to(reward_row, LEFT, buff=0.35)
        advantage_label.next_to(advantage_row, LEFT, buff=0.35)
        calculation = callout(
            "mean = 0.5   ·   standard deviation = 0.5   ·   Aᵢ = (rᵢ − 0.5) / 0.5",
            width=10.7,
            size=23,
        )
        calculation.move_to(ORIGIN)
        winners = pill("increase probability", INK, width=2.35)
        losers = pill("decrease probability", MUTED, width=2.35)
        winners.next_to(advantage_row, DOWN, buff=0.38).shift(LEFT * 1.4)
        losers.next_to(advantage_row, DOWN, buff=0.38).shift(RIGHT * 1.4)
        self.reveal(heading, reward_label, reward_row)
        self.reveal(calculation)
        self.play(
            TransformFromCopy(reward_row, advantage_row),
            FadeIn(advantage_label),
            run_time=1.5,
        )
        self.reveal(winners, losers)
        self.source("Simplified binary-reward group with ε omitted", label="WORKED EXAMPLE")
        self.hold(4.8)
        self.wipe()

    def _probability_ratio(self) -> None:
        heading = self.heading(
            "Clipped probability ratios",
            "PPO → GRPO",
            subtitle="GRPO keeps this PPO-style clipped policy update.",
        )
        frame = plot_frame(
            x_label="IMPORTANCE RATIO  ρ",
            y_label="POSITIVE-ADVANTAGE OBJECTIVE",
            width=7.0,
            height=3.65,
        )
        frame.group.move_to(LEFT * 1.7 + DOWN * 0.25)
        frame.origin += LEFT * 1.7 + DOWN * 0.25
        xs = np.linspace(0, 1, 31)
        unclipped = line_graph(
            frame,
            [(x, x) for x in xs],
            color=MUTED,
            stroke_width=3,
        )
        clipped_curve = line_graph(
            frame,
            [(x, min(x, 0.75)) for x in xs],
            color=AMBER,
            stroke_width=5,
        )
        clip_line = DashedLine(
            frame.point(0.75, 0),
            frame.point(0.75, 0.88),
            color=CORAL,
            stroke_width=2,
        )
        clip_label = pill("clip at ρ = 1.20", CORAL, width=2.05)
        clip_label.move_to(frame.point(0.76, 0.9))
        example = panel(
            "ONE SAMPLED TOKEN",
            [
                "πold(a|s) = 0.10",
                "πθ(a|s) = 0.13",
                "ρ = 1.30",
                "objective uses 1.20",
            ],
            width=3.2,
            height=3.25,
            color=VIOLET,
            body_size=18,
        )
        example.move_to(RIGHT * 4.7 + DOWN * 0.15)
        clipped_note = callout(
            "The token may reach ρ = 1.30, but positive-advantage credit stops growing after 1.20.",
            width=11.2,
            size=22,
        )
        clipped_note.to_edge(DOWN, buff=0.7)
        self.reveal(heading, frame.group, example)
        self.play(ShowCreation(unclipped), run_time=1.0)
        self.play(
            ShowCreation(clipped_curve),
            ShowCreation(clip_line),
            FadeIn(clip_label),
            run_time=1.2,
        )
        self.reveal(clipped_note)
        self.source(
            "PPO clipped surrogate · arXiv:1707.06347 · adopted by GRPO in arXiv:2402.03300",
            label="PAPER CONNECTION",
        )
        self.hold(4.4)
        self.wipe()

    def _contrast_graph(self) -> None:
        heading = self.heading(
            "When groups teach",
            "GRPO",
            subtitle="With binary rewards, learning needs at least one success and one failure.",
        )
        frame = plot_frame(
            x_label="SINGLE-SAMPLE SUCCESS RATE  p",
            y_label="CHANCE GROUP IS MIXED",
            width=9.3,
            height=4.1,
        )
        frame.group.shift(DOWN * 0.35)
        frame.origin += DOWN * 0.35

        def contrast_points(group_size: int) -> list[tuple[float, float]]:
            return [
                (
                    p,
                    1 - p**group_size - (1 - p) ** group_size,
                )
                for p in np.linspace(0, 1, 41)
            ]

        g2 = line_graph(frame, contrast_points(2), color=CORAL, stroke_width=3)
        g4 = line_graph(frame, contrast_points(4), color=BLUE, stroke_width=4)
        g8 = line_graph(frame, contrast_points(8), color=GREEN, stroke_width=5)
        labels = VGroup(
            pill("G = 2", CORAL, width=1.15),
            pill("G = 4", BLUE, width=1.15),
            pill("G = 8", GREEN, width=1.15),
        )
        labels[0].move_to(frame.point(0.72, 0.42))
        labels[1].move_to(frame.point(0.77, 0.66))
        labels[2].move_to(frame.point(0.82, 0.84))
        formula = pill("P(mixed) = 1 − pᴳ − (1−p)ᴳ", INK, width=3.7)
        formula.move_to(frame.point(0.27, 0.88))
        self.reveal(heading, frame.group, formula)
        self.play(ShowCreation(g2), FadeIn(labels[0]), run_time=1.0)
        self.play(ShowCreation(g4), FadeIn(labels[1]), run_time=1.0)
        self.play(ShowCreation(g8), FadeIn(labels[2]), run_time=1.0)
        self.source("Exact probability for independent binary rewards", label="DERIVATION")
        self.hold(4.8)
        self.wipe()

    def _zero_variance(self) -> None:
        heading = self.heading(
            "Zero-variance groups",
            "DAPO · dynamic sampling · 2025",
            subtitle="If every reward is equal, the normalized group advantage is zero.",
        )
        easy = panel(
            "TOO EASY",
            [
                "rewards: 1 1 1 1 1 1 1 1",
                "mean = 1",
                "no winner inside the group",
            ],
            width=5.0,
            height=2.65,
            color=CORAL,
            body_size=19,
        )
        hard = panel(
            "TOO HARD",
            [
                "rewards: 0 0 0 0 0 0 0 0",
                "mean = 0",
                "no winner inside the group",
            ],
            width=5.0,
            height=2.65,
            color=CORAL,
            body_size=19,
        )
        pair = VGroup(easy, hard).arrange(RIGHT, buff=0.65)
        pair.move_to(UP * 0.25)
        curriculum = self.conclusion(
            "A useful curriculum keeps prompts near the model's learning frontier."
        )
        band = VGroup(
            pill("0% success", MUTED, width=1.5),
            Arrow(LEFT, RIGHT, color=MUTED, stroke_width=3),
            pill("mixed groups", INK, width=1.65),
            Arrow(LEFT, RIGHT, color=MUTED, stroke_width=3),
            pill("100% success", MUTED, width=1.65),
        ).arrange(RIGHT, buff=0.22)
        band.next_to(pair, DOWN, buff=0.45)
        self.reveal(heading)
        self.play(FadeIn(easy, shift=RIGHT * 0.1), FadeIn(hard, shift=LEFT * 0.1))
        self.reveal(band, curriculum)
        self.source("Dynamic sampling is used in DAPO · arXiv:2503.14476", label="CURRICULUM")
        self.hold(4.5)
        self.wipe()

    def _length_bias(self) -> None:
        heading = self.heading(
            "Length bias",
            "GRPO",
            subtitle="Normalization choices change which trajectories dominate the gradient.",
        )
        concise = panel(
            "CONCISE CORRECT ANSWER",
            [
                "180 tokens",
                "reward = 1",
                "clear derivation",
            ],
            width=3.6,
            height=2.7,
            color=GREEN,
            body_size=20,
        )
        verbose = panel(
            "VERBOSE CORRECT ANSWER",
            [
                "1,400 tokens",
                "reward = 1",
                "many redundant steps",
            ],
            width=3.6,
            height=2.7,
            color=AMBER,
            body_size=20,
        )
        token_bars = VGroup()
        for width, label in [(1.0, "180"), (5.4, "1,400")]:
            bar = Rectangle(
                width=width,
                height=0.38,
                stroke_width=0,
                fill_color=INK if width < 2 else MUTED,
                fill_opacity=0.9,
            )
            copy = text(f"{label} token contributions", size=16, color=INK)
            copy.next_to(bar, RIGHT, buff=0.15)
            token_bars.add(VGroup(bar, copy))
        token_bars.arrange(DOWN, aligned_edge=LEFT, buff=0.35)
        token_bars.move_to(DOWN * 1.55)
        pair = VGroup(concise, verbose).arrange(RIGHT, buff=1.0)
        pair.move_to(UP * 0.55)
        self.reveal(heading, pair)
        self.play(
            LaggedStart(*[GrowFromEdge(item[0], LEFT) for item in token_bars], lag_ratio=0.2),
            FadeIn(VGroup(*[item[1] for item in token_bars])),
            run_time=1.5,
        )
        note = self.conclusion(
            "Length, group-variance, and clipping choices are part of the algorithm—not bookkeeping."
        )
        self.reveal(note)
        self.source(
            "DAPO · arXiv:2503.14476 · Dr. GRPO analysis in arXiv:2503.20783",
            label="BIAS CONTROL",
        )
        self.hold(4.6)
        self.wipe()

    def _diversity_metrics(self) -> None:
        heading = self.heading(
            "Pass@1 versus pass@k",
            "GRPO",
            subtitle="One measures reliability; the other reveals remaining solution diversity.",
        )
        pass1 = panel(
            "PASS@1",
            [
                "one sampled answer",
                "deployment reliability",
                "can rise as policy sharpens",
            ],
            width=4.45,
            height=3.2,
            color=GREEN,
            body_size=20,
        )
        passk = panel(
            "PASS@K",
            [
                "success within k samples",
                "search / exploration capacity",
                "can fall under collapse",
            ],
            width=4.45,
            height=3.2,
            color=BLUE,
            body_size=20,
        )
        pair = VGroup(pass1, passk).arrange(RIGHT, buff=0.9)
        pair.move_to(DOWN * 0.05)
        example = callout(
            "Model A: pass@1 = 55%, pass@8 = 82%   ·   Model B: pass@1 = 60%, pass@8 = 63%",
            width=11.4,
            size=21,
        )
        example.to_edge(DOWN, buff=0.72)
        self.reveal(heading)
        self.play(FadeIn(pass1, shift=RIGHT * 0.1), FadeIn(passk, shift=LEFT * 0.1))
        self.reveal(example)
        self.source("Illustrative metrics; values are not paper results", label="READING RESULTS")
        self.hold(4.5)
        self.wipe()

    def _where_it_fits(self) -> None:
        heading = self.heading(
            "PPO versus GRPO",
            "PPO → GRPO",
        )
        shared = callout(
            "Shared: current-policy rollouts · rewards · behavior log-probs · clipped ratios · gradients",
            color=VIOLET,
            width=11.4,
            size=21,
        )
        shared.move_to(UP * 1.7)
        ppo = panel(
            "PPO",
            [
                "baseline: learned critic Vψ(s)",
                "advantage: return − predicted value",
                "GAE: Generalized Advantage Estimation",
                "requires value-model optimization",
            ],
            width=5.25,
            height=3.55,
            color=BLUE,
            body_size=19,
        )
        grpo = panel(
            "GRPO",
            [
                "baseline: group mean / standard deviation",
                "advantage: response versus siblings",
                "same prompt produces G completions",
                "removes the separate critic",
            ],
            width=5.25,
            height=3.55,
            color=GREEN,
            body_size=19,
        )
        pair = VGroup(ppo, grpo).arrange(RIGHT, buff=0.75)
        pair.move_to(DOWN * 0.45)
        self.reveal(heading, shared)
        self.play(
            FadeIn(ppo, shift=RIGHT * 0.12),
            FadeIn(grpo, shift=LEFT * 0.12),
            run_time=1.4,
        )
        self.source(
            "PPO · arXiv:1707.06347   ·   DeepSeekMath / GRPO · arXiv:2402.03300   ·   DeepSeek-R1 · arXiv:2501.12948",
            label="PAPER LINEAGE",
        )
        self.hold(4.6)
        self.wipe()
