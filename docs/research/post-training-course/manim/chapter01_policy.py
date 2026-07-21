"""Chapter 1: one policy decision, one evaluation, and one update."""

from pathlib import Path

from manimlib import *

from components import (
    BarDatum,
    bar_chart,
    line_graph,
    node,
    plot_frame,
    signal_legend,
    text,
)
from course_base import LessonScene
from theme import (
    AMBER,
    BLUE,
    CORAL,
    CYAN,
    GREEN,
    INK,
    MONO_FONT,
    MUTED,
    PINK,
    VIOLET,
)


class Chapter01Policy(LessonScene):
    chapter_number = 1
    chapter_color = CYAN
    hold_scale = 5.8

    def construct(self) -> None:
        self._openpond_intro()
        self._course_title()
        self._course_contents()
        self._policy_chooses()
        self._loss_in_plain_english()
        self._training_changes_the_odds()

    def _openpond_intro(self) -> None:
        """Mirror the app splash: mark first, then reveal OpenPond letter by letter."""
        icon_path = (
            Path(__file__).resolve().parents[4]
            / "apps"
            / "web"
            / "public"
            / "openpond-icon.png"
        )
        mark = ImageMobject(str(icon_path))
        mark.set_height(1.34)
        wordmark = text("OpenPond", size=42, color=INK, weight="BOLD")
        Group(mark, wordmark).arrange(RIGHT, buff=-0.08).move_to(ORIGIN)

        self.play(FadeIn(mark, scale=0.92), run_time=0.45)
        self.wait(0.52)
        for glyph in wordmark:
            self.play(FadeIn(glyph, shift=LEFT * 0.06), run_time=0.14)
            self.wait(0.10)
        self.wait(0.35)
        self.wipe()

    def _course_title(self) -> None:
        title = text(
            "Post-training from first principles",
            size=56,
            color=INK,
            weight="BOLD",
        )
        subtitle = text(
            "How rewards and teacher feedback change a model",
            size=27,
            color=MUTED,
        )
        rule = Line(LEFT * 4.8, RIGHT * 4.8, color=CYAN, stroke_width=2.5)
        VGroup(title, rule, subtitle).arrange(DOWN, buff=0.34).move_to(ORIGIN)
        self.reveal(title, run_time=0.65)
        self.play(ShowCreation(rule), run_time=0.45)
        self.reveal(subtitle, run_time=0.45)
        self.hold(0.48)
        self.wipe()

    def _course_contents(self) -> None:
        title = text("Contents", size=46, color=INK, weight="BOLD")
        subtitle = text(
            "Nine chapters · about twenty-four minutes",
            size=21,
            color=MUTED,
        )
        heading = VGroup(title, subtitle).arrange(DOWN, buff=0.16)
        heading.to_edge(UP, buff=0.42).to_edge(LEFT, buff=1.85)

        # Updated after the final chapter render. Keeping the complete map here
        # makes the opening useful as a navigable table of contents.
        chapters = [
            ("00:00", "Choose, judge, update", CYAN),
            ("01:09", "Definitions", VIOLET),
            ("05:50", "On- and off-policy data", BLUE),
            ("06:52", "From outcomes to credit", AMBER),
            ("09:47", "Verifiable rewards", GREEN),
            ("12:35", "PPO and GRPO", CYAN),
            ("15:24", "Distillation", VIOLET),
            ("18:01", "Teacher-guided methods", PINK),
            ("20:39", "Credible experiments", GREEN),
        ]
        entries = VGroup()
        for timestamp_value, chapter, color in chapters:
            timestamp = text(
                timestamp_value,
                size=20,
                color=color,
                weight="BOLD",
                font=MONO_FONT,
            )
            name = text(chapter, size=23, color=INK, weight="BOLD")
            entries.add(VGroup(timestamp, name).arrange(RIGHT, buff=0.24))
        entries.arrange(DOWN, aligned_edge=LEFT, buff=0.23)
        entries.move_to(DOWN * 0.62 + LEFT * 1.15)

        label = text("Course map", size=14, color=CYAN)
        label.to_corner(DR, buff=0.28)

        self.reveal(heading, label, run_time=0.6)
        self.play(
            LaggedStart(
                *[FadeIn(entry, shift=UP * 0.06) for entry in entries],
                lag_ratio=0.08,
            ),
            run_time=1.15,
        )
        self.hold(0.65)
        self.wipe()

    def _policy_chooses(self) -> None:
        heading = self.heading(
            "A policy chooses",
            "Policy",
            subtitle="The model assigns a probability to each possible action.",
        )
        state = node(
            "State\ncancellation test fails",
            color=BLUE,
            width=2.6,
            height=1.12,
        )
        state.move_to(LEFT * 4.7 + UP * 0.45)
        policy = bar_chart(
            [
                BarDatum("return None", 54, MUTED),
                BarDatum("raise error", 30, CYAN),
                BarDatum("retry", 16, MUTED),
            ],
            max_value=60,
            width=4.8,
            height=3.3,
            value_suffix="%",
            value_decimals=0,
        )
        policy.move_to(RIGHT * 1.7 + UP * 0.35)
        policy_arrow = Arrow(
            state.get_right(),
            policy.get_left(),
            buff=0.18,
            color=MUTED,
            stroke_width=3,
        )
        sampled = node(
            "sampled action\nraise CancelledError()",
            color=GREEN,
            width=3.25,
            height=1.02,
            size=19,
        )
        sampled.move_to(RIGHT * 1.7 + DOWN * 2.0)
        sample_arrow = Arrow(
            policy.get_bottom(),
            sampled.get_top(),
            buff=0.16,
            color=GREEN,
            stroke_width=3,
        )
        takeaway = self.conclusion(
            "The policy is the menu of chances; one sample becomes the action the environment sees."
        )

        self.reveal(heading, state)
        self.play(ShowCreation(policy_arrow), FadeIn(policy), run_time=1.05)
        self.play(ShowCreation(sample_arrow), FadeIn(sampled), run_time=0.85)
        self.reveal(takeaway, run_time=0.5)
        self.hold(2.15)
        self.wipe()

    def _loss_in_plain_english(self) -> None:
        heading = self.heading(
            "Loss",
            "Policy",
            subtitle="Training lowers an objective; held-out evaluation checks what was learned.",
        )
        useful_frame = plot_frame(
            x_label="updates",
            y_label="loss",
            width=4.35,
            height=2.45,
            ticks=4,
        )
        misleading_frame = plot_frame(
            x_label="updates",
            y_label="loss",
            width=4.35,
            height=2.45,
            ticks=4,
        )
        training_points = [
            (0.0, 0.88),
            (0.18, 0.70),
            (0.38, 0.51),
            (0.62, 0.34),
            (0.82, 0.23),
            (1.0, 0.17),
        ]
        useful_eval_points = [
            (0.0, 0.84),
            (0.18, 0.72),
            (0.38, 0.57),
            (0.62, 0.43),
            (0.82, 0.34),
            (1.0, 0.29),
        ]
        misleading_eval_points = [
            (0.0, 0.84),
            (0.18, 0.73),
            (0.38, 0.65),
            (0.62, 0.69),
            (0.82, 0.80),
            (1.0, 0.94),
        ]
        useful_training = line_graph(useful_frame, training_points, color=CYAN)
        useful_eval = line_graph(useful_frame, useful_eval_points, color=GREEN)
        misleading_training = line_graph(
            misleading_frame,
            training_points,
            color=CYAN,
        )
        misleading_eval = line_graph(
            misleading_frame,
            misleading_eval_points,
            color=CORAL,
        )
        useful = VGroup(useful_frame.group, useful_training, useful_eval)
        misleading = VGroup(
            misleading_frame.group,
            misleading_training,
            misleading_eval,
        )
        useful.move_to(LEFT * 3.25 + DOWN * 0.42)
        misleading.move_to(RIGHT * 3.25 + DOWN * 0.42)
        useful_label = text("Useful training", size=22, color=GREEN, weight="BOLD")
        misleading_label = text(
            "Training the wrong thing",
            size=22,
            color=CORAL,
            weight="BOLD",
        )
        useful_label.next_to(useful, UP, buff=0.18)
        misleading_label.next_to(misleading, UP, buff=0.18)
        legend = signal_legend(
            [
                ("training objective", CYAN),
                ("held-out error improves", GREEN),
                ("held-out error worsens", CORAL),
            ]
        )
        legend.move_to(DOWN * 2.60)
        lesson = self.conclusion(
            "A lower training loss only means the model got better at the objective you wrote."
        )

        self.reveal(heading, useful_label, misleading_label)
        self.play(
            ShowCreation(useful_frame.group),
            ShowCreation(misleading_frame.group),
            run_time=0.95,
        )
        self.play(
            ShowCreation(useful_training),
            ShowCreation(misleading_training),
            run_time=1.05,
        )
        self.play(
            ShowCreation(useful_eval),
            ShowCreation(misleading_eval),
            run_time=1.15,
        )
        self.reveal(legend, lesson, run_time=0.6)
        self.hold(2.2)
        self.wipe()

    def _training_changes_the_odds(self) -> None:
        heading = self.heading(
            "An update changes the odds",
            "Policy",
            subtitle="Passing tests makes the successful action more likely in similar states.",
        )
        before = bar_chart(
            [
                BarDatum("return None", 54, MUTED),
                BarDatum("raise error", 30, CYAN),
                BarDatum("retry", 16, MUTED),
            ],
            max_value=60,
            width=3.55,
            height=2.85,
            value_suffix="%",
            value_decimals=0,
        )
        after = bar_chart(
            [
                BarDatum("return None", 49, MUTED),
                BarDatum("raise error", 35, GREEN),
                BarDatum("retry", 16, MUTED),
            ],
            max_value=60,
            width=3.55,
            height=2.85,
            value_suffix="%",
            value_decimals=0,
        )
        before.move_to(LEFT * 4.45 + DOWN * 0.30)
        after.move_to(RIGHT * 4.45 + DOWN * 0.30)
        before_label = text("Before", size=20, color=MUTED, weight="BOLD")
        after_label = text("After", size=20, color=GREEN, weight="BOLD")
        before_label.next_to(before, UP, buff=0.14)
        after_label.next_to(after, UP, buff=0.14)

        sampled = node("sample\nraise error", color=CYAN, width=2.4, height=0.88, size=18)
        judged = node("run tests\npass", color=GREEN, width=2.4, height=0.88, size=18)
        update = node("update model\nlower loss", color=AMBER, width=2.4, height=0.88, size=18)
        story = VGroup(sampled, judged, update).arrange(DOWN, buff=0.40)
        story.move_to(DOWN * 0.25)
        story_arrows = VGroup(
            Arrow(sampled.get_bottom(), judged.get_top(), buff=0.10, color=MUTED),
            Arrow(judged.get_bottom(), update.get_top(), buff=0.10, color=MUTED),
        )
        enter = Arrow(before.get_right(), sampled.get_left(), buff=0.14, color=MUTED)
        leave = Arrow(update.get_right(), after.get_left(), buff=0.14, color=GREEN)
        takeaway = self.conclusion(
            "That loop is post-training: choose, judge, update, then choose again."
        )

        self.reveal(heading, before, before_label)
        self.play(ShowCreation(enter), FadeIn(sampled), run_time=0.65)
        for arrow, step in zip(story_arrows, [judged, update]):
            self.play(ShowCreation(arrow), FadeIn(step), run_time=0.65)
        self.play(
            ShowCreation(leave),
            FadeIn(after),
            FadeIn(after_label),
            run_time=0.9,
        )
        self.reveal(takeaway, run_time=0.5)
        self.hold(2.4)
        self.wipe()
