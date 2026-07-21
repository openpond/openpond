"""Chapter 6: knowledge distillation, KL, temperature, and self-distillation."""

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
from theme import AMBER, BLUE, CORAL, GREEN, INK, MUTED, VIOLET


class Chapter06Distillation(LessonScene):
    chapter_number = 7
    chapter_color = BLUE

    def construct(self) -> None:
        self._hard_vs_soft()
        self._distillation_loss()
        self._worked_distribution()
        self._temperature()
        self._kl_direction()
        self._offline_vs_on_policy()
        self._same_weights()

    def _hard_vs_soft(self) -> None:
        heading = self.heading(
            "A teacher sees alternatives",
            "Distillation",
            subtitle="For the same cancellation prefix, one token target hides alternatives that a distribution preserves.",
        )
        hard = bar_chart(
            [
                BarDatum("cancel", 100, GREEN),
                BarDatum("raise", 0, MUTED),
                BarDatum("return", 0, MUTED),
                BarDatum("retry", 0, MUTED),
            ],
            max_value=100,
            width=4.6,
            height=3.4,
            value_suffix="%",
            value_decimals=0,
        )
        soft = bar_chart(
            [
                BarDatum("cancel", 55, VIOLET),
                BarDatum("raise", 25, BLUE),
                BarDatum("return", 15, MUTED),
                BarDatum("retry", 5, CORAL),
            ],
            max_value=100,
            width=4.6,
            height=3.4,
            value_suffix="%",
            value_decimals=0,
        )
        hard.move_to(LEFT * 3.0 + DOWN * 0.15)
        soft.move_to(RIGHT * 3.0 + DOWN * 0.15)
        hard_label = text("ONE-HOT TARGET", size=18, color=MUTED, weight="BOLD")
        soft_label = text("TEACHER DISTRIBUTION", size=18, color=INK, weight="BOLD")
        hard_label.next_to(hard, UP, buff=0.15)
        soft_label.next_to(soft, UP, buff=0.15)
        self.reveal(heading)
        self.play(
            FadeIn(VGroup(hard, hard_label), shift=RIGHT * 0.1),
            FadeIn(VGroup(soft, soft_label), shift=LEFT * 0.1),
            run_time=1.5,
        )
        note = self.conclusion(
            "Both favor “cancel,” but only the soft target says which alternatives are plausible."
        )
        self.reveal(note)
        self.source("Illustrative next-token probabilities", label="WORKED EXAMPLE")
        self.hold(4.5)
        self.wipe()

    def _distillation_loss(self) -> None:
        heading = self.heading(
            "Distillation loss",
            "Distillation",
            subtitle="The target is a distribution qT; the student supplies probabilities pS.",
        )
        teacher = panel(
            "TEACHER qT(v)",
            ["cancel  0.55", "raise   0.25", "return  0.15", "retry   0.05"],
            color=VIOLET,
            width=3.15,
            height=3.35,
            body_size=20,
        )
        student = panel(
            "STUDENT pS(v)",
            ["cancel  0.18", "raise   0.12", "return  0.50", "retry   0.20"],
            color=BLUE,
            width=3.15,
            height=3.35,
            body_size=20,
        )
        distributions = VGroup(teacher, student).arrange(RIGHT, buff=0.45)
        distributions.move_to(LEFT * 3.25 + DOWN * 0.2)
        loss = panel(
            "TOKEN-LEVEL LOSS",
            [
                "H(qT, pS)",
                "= −Σᵥ qT(v) log pS(v)",
                "backpropagate through pS",
            ],
            color=AMBER,
            width=4.6,
            height=2.8,
            body_size=21,
        )
        loss.move_to(RIGHT * 3.85 + UP * 0.25)
        arrow = arrow_between(distributions, loss)
        identity = pill(
            "min H(qT,pS)  ⇔  min KL(qT || pS)",
            VIOLET,
            width=4.15,
        )
        identity.next_to(loss, DOWN, buff=0.35)
        applies = pill(
            "USED BY  on-policy KD · OPSD · SDFT · SDPO",
            BLUE,
            width=5.25,
        )
        applies.next_to(identity, DOWN, buff=0.28)
        self.reveal(heading, teacher, student)
        self.play(ShowCreation(arrow), FadeIn(loss), run_time=0.9)
        self.reveal(identity, applies, run_time=0.55)
        self.hold(1.35)
        self.wipe()

    def _worked_distribution(self) -> None:
        heading = self.heading(
            "Student follows teacher",
            "Distillation",
            subtitle="The comparison happens at every token position.",
        )
        teacher_data = [
            BarDatum("cancel", 55, VIOLET),
            BarDatum("raise", 25, BLUE),
            BarDatum("return", 15, MUTED),
            BarDatum("retry", 5, CORAL),
        ]
        student_before_data = [
            BarDatum("cancel", 18, BLUE),
            BarDatum("raise", 12, MUTED),
            BarDatum("return", 50, BLUE),
            BarDatum("retry", 20, CORAL),
        ]
        student_after_data = [
            BarDatum("cancel", 43, BLUE),
            BarDatum("raise", 23, MUTED),
            BarDatum("return", 23, BLUE),
            BarDatum("retry", 11, CORAL),
        ]
        teacher = bar_chart(
            teacher_data,
            max_value=60,
            width=4.7,
            height=3.25,
            value_suffix="%",
            value_decimals=0,
        )
        student_before = bar_chart(
            student_before_data,
            max_value=60,
            width=4.7,
            height=3.25,
            value_suffix="%",
            value_decimals=0,
        )
        student_after = bar_chart(
            student_after_data,
            max_value=60,
            width=4.7,
            height=3.25,
            value_suffix="%",
            value_decimals=0,
        )
        teacher.move_to(LEFT * 3.0 + DOWN * 0.2)
        student_before.move_to(RIGHT * 3.0 + DOWN * 0.2)
        student_after.move_to(student_before)
        teacher_label = text("TEACHER", size=18, color=INK, weight="BOLD")
        before_label = text("STUDENT · BEFORE", size=18, color=MUTED, weight="BOLD")
        after_label = text("STUDENT · AFTER ONE UPDATE", size=18, color=INK, weight="BOLD")
        teacher_label.next_to(teacher, UP, buff=0.15)
        before_label.next_to(student_before, UP, buff=0.15)
        after_label.next_to(student_after, UP, buff=0.15)
        divergence = VGroup(
            Arrow(
                teacher.get_right() + UP * 0.10,
                student_before.get_left() + UP * 0.10,
                buff=0.22,
                color=MUTED,
                stroke_width=3,
            ),
            Arrow(
                student_before.get_left() + DOWN * 0.10,
                teacher.get_right() + DOWN * 0.10,
                buff=0.22,
                color=MUTED,
                stroke_width=3,
            ),
        )
        kl = pill("KL gap", MUTED, width=1.25)
        kl.next_to(divergence, UP, buff=0.15)
        self.reveal(heading, teacher, teacher_label, student_before, before_label)
        self.play(ShowCreation(divergence), FadeIn(kl), run_time=1.0)
        self.hold(1.4)
        self.play(
            ReplacementTransform(student_before, student_after),
            ReplacementTransform(before_label, after_label),
            run_time=1.8,
        )
        self.source("Illustrative distribution-matching update", label="WORKED EXAMPLE")
        self.hold(4.2)
        self.wipe()

    def _temperature(self) -> None:
        heading = self.heading(
            "Teacher temperature",
            "Distillation",
            subtitle="The ranking stays the same while the distribution becomes sharper or softer.",
        )
        cold = bar_chart(
            [
                BarDatum("A", 83, VIOLET),
                BarDatum("B", 12, MUTED),
                BarDatum("C", 4, MUTED),
                BarDatum("D", 1, CORAL),
            ],
            max_value=90,
            width=4.7,
            height=3.45,
            value_suffix="%",
            value_decimals=0,
        )
        warm = bar_chart(
            [
                BarDatum("A", 39, VIOLET),
                BarDatum("B", 27, BLUE),
                BarDatum("C", 20, MUTED),
                BarDatum("D", 14, CORAL),
            ],
            max_value=90,
            width=4.7,
            height=3.45,
            value_suffix="%",
            value_decimals=0,
        )
        cold.move_to(LEFT * 3.0 + DOWN * 0.2)
        warm.move_to(RIGHT * 3.0 + DOWN * 0.2)
        cold_label = text("LOW T · SHARP TARGET", size=18, color=INK, weight="BOLD")
        warm_label = text("HIGH T · SOFT TARGET", size=18, color=MUTED, weight="BOLD")
        cold_label.next_to(cold, UP, buff=0.16)
        warm_label.next_to(warm, UP, buff=0.16)
        self.reveal(heading)
        self.play(
            FadeIn(VGroup(cold, cold_label), shift=RIGHT * 0.1),
            FadeIn(VGroup(warm, warm_label), shift=LEFT * 0.1),
            run_time=1.5,
        )
        note = self.conclusion(
            "Too sharp becomes almost one-hot; too soft can magnify an unhelpful tail."
        )
        self.reveal(note)
        self.source("Same illustrative logit ranking at two temperatures", label="CONCEPTUAL")
        self.hold(4.4)
        self.wipe()

    def _kl_direction(self) -> None:
        heading = self.heading(
            "KL direction",
            "Distillation",
            subtitle="Kullback–Leibler direction determines which distributional mistakes cost more.",
        )
        forward = panel(
            "FORWARD KL  ·  KL(T || S)",
            [
                "teacher defines the expectation",
                "student is penalized for missing",
                "teacher-supported alternatives",
            ],
            width=5.0,
            height=3.15,
            color=VIOLET,
            body_size=20,
        )
        reverse = panel(
            "REVERSE KL  ·  KL(S || T)",
            [
                "student defines the expectation",
                "strongly penalizes probability",
                "where the teacher is unlikely",
            ],
            width=5.0,
            height=3.15,
            color=BLUE,
            body_size=20,
        )
        pair = VGroup(forward, reverse).arrange(RIGHT, buff=0.65)
        pair.move_to(DOWN * 0.1)
        caution = self.conclusion(
            "“Use KL” is incomplete: direction, support, temperature, and clipping all matter."
        )
        self.reveal(heading)
        self.play(
            FadeIn(forward, shift=RIGHT * 0.1),
            FadeIn(reverse, shift=LEFT * 0.1),
            run_time=1.4,
        )
        self.reveal(caution)
        self.source("Distribution-divergence intuition", label="OBJECTIVE")
        self.hold(4.5)
        self.wipe()

    def _offline_vs_on_policy(self) -> None:
        heading = self.heading(
            "Whose prefix?",
            "GKD paper · on-policy distillation",
            subtitle="Teacher prefixes and student prefixes create different training states.",
        )
        offline = panel(
            "OFFLINE DISTILLATION",
            [
                "teacher generates sequences first",
                "student trains on fixed prefixes",
                "cheap, stable, exposure mismatch",
            ],
            width=5.0,
            height=3.35,
            color=MUTED,
            body_size=20,
        )
        online = panel(
            "ON-POLICY DISTILLATION",
            [
                "student generates current prefixes",
                "teacher scores those prefixes",
                "fresh errors, repeated inference",
            ],
            width=5.0,
            height=3.35,
            color=BLUE,
            body_size=20,
        )
        pair = VGroup(offline, online).arrange(RIGHT, buff=0.65)
        pair.move_to(DOWN * 0.1)
        prefixes = VGroup(
            pill("teacher prefix", MUTED, width=1.7),
            pill("student prefix", BLUE, width=1.7),
        )
        prefixes[0].next_to(offline, DOWN, buff=0.25)
        prefixes[1].next_to(online, DOWN, buff=0.25)
        self.reveal(heading)
        self.play(FadeIn(offline), FadeIn(prefixes[0]), run_time=1.0)
        self.play(FadeIn(online), FadeIn(prefixes[1]), run_time=1.0)
        self.source("Generalized Knowledge Distillation · arXiv:2306.13649", label="EXPOSURE")
        self.hold(4.5)
        self.wipe()

    def _same_weights(self) -> None:
        heading = self.heading(
            "Privileged context",
            "Distillation",
            subtitle="The teacher can have the same weights but a more informative context.",
        )
        weights = node("Same frozen weights", color=AMBER, width=2.45, height=1.0)
        weights.move_to(UP * 1.65)
        student_context = panel(
            "STUDENT VIEW",
            [
                "problem",
                "current sampled prefix",
                "deployment-visible context",
            ],
            width=4.4,
            height=2.8,
            color=BLUE,
            body_size=19,
        )
        teacher_context = panel(
            "TEACHER VIEW",
            [
                "same problem and prefix",
                "+ solution, demo, or feedback",
                "training-only context",
            ],
            width=4.4,
            height=2.8,
            color=VIOLET,
            body_size=19,
        )
        pair = VGroup(student_context, teacher_context).arrange(RIGHT, buff=1.25)
        pair.move_to(DOWN * 0.45)
        branches = VGroup(
            Arrow(weights.get_bottom(), student_context.get_top(), color=BLUE, buff=0.15),
            Arrow(weights.get_bottom(), teacher_context.get_top(), color=VIOLET, buff=0.15),
        )
        transfer = Arrow(
            teacher_context.get_left(),
            student_context.get_right(),
            buff=0.15,
            color=VIOLET,
            stroke_width=4,
        )
        transfer_label = pill("match token distributions", VIOLET, width=2.75)
        transfer_label.next_to(transfer, UP, buff=0.12)
        self.reveal(heading, weights)
        self.play(
            *[ShowCreation(branch) for branch in branches],
            FadeIn(student_context),
            FadeIn(teacher_context),
            run_time=1.3,
        )
        self.play(ShowCreation(transfer), FadeIn(transfer_label), run_time=1.0)
        note = self.conclusion(
            "The advantage comes from conditioning, not necessarily a larger teacher."
        )
        self.reveal(note)
        self.source("Shared mechanism in OPSD, SDFT, and SDPO", label="SELF-DISTILLATION")
        self.hold(4.5)
        self.wipe()

    def _top_k_storage(self) -> None:
        heading = self.heading(
            "Top-k teacher logits",
            "Distillation",
            subtitle="Full distributions are informative but expensive at large vocabulary size.",
        )
        full = panel(
            "FULL VOCABULARY",
            [
                "≈ 150,000 values per token",
                "faithful tail information",
                "large memory and bandwidth",
            ],
            width=4.4,
            height=3.15,
            color=VIOLET,
            body_size=20,
        )
        compressed = panel(
            "TOP-K + TAIL",
            [
                "store highest-k logits",
                "approximate remaining mass",
                "validate approximation error",
            ],
            width=4.4,
            height=3.15,
            color=BLUE,
            body_size=20,
        )
        pair = VGroup(full, compressed).arrange(RIGHT, buff=0.95)
        pair.move_to(DOWN * 0.05)
        arrow = arrow_between(full, compressed, color=AMBER)
        self.reveal(heading, full)
        self.play(ShowCreation(arrow), FadeIn(compressed), run_time=1.2)
        warning = self.conclusion(
            "Compression is an experimental variable: measure its loss and its systems savings."
        )
        self.reveal(warning)
        self.source("SDPO top-k teacher logits · arXiv:2601.20802", label="SYSTEMS")
        self.hold(4.5)
        self.wipe()
