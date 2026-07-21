"""Shared scene behavior for the first-principles post-training course."""

from __future__ import annotations

import os
from pathlib import Path

from manimlib import *

from components import (
    callout,
    chapter_marker,
    course_title,
    fit_width,
    panel,
    pill,
    slide_heading,
    text,
)
from theme import CORAL, CYAN, GREEN, INK, MUTED, apply_course_background


class LessonScene(Scene):
    chapter_number = 0
    chapter_count = 9
    chapter_color = CYAN

    # The narration carries the explanation; visuals pause long enough for the
    # mathematical relationship to register without feeling like static slides.
    animation_scale = float(os.environ.get("COURSE_ANIMATION_SCALE", "1.10"))
    hold_scale = float(os.environ.get("COURSE_HOLD_SCALE", "4.400"))

    def setup(self) -> None:
        apply_course_background(self)

    def play(self, *args, **kwargs):
        kwargs["run_time"] = kwargs.get("run_time", 1.0) * self.animation_scale
        return super().play(*args, **kwargs)

    def reveal(self, *mobjects: Mobject, run_time: float = 0.8) -> None:
        self.play(
            *[FadeIn(mob, shift=UP * 0.08) for mob in mobjects],
            run_time=run_time,
        )

    def hold(self, duration: float = 3.0) -> None:
        self.wait(duration * self.hold_scale)

    def wipe(self, *mobjects: Mobject) -> None:
        targets = list(mobjects) if mobjects else list(self.mobjects)
        if targets:
            self.play(
                *[FadeOut(mob, shift=DOWN * 0.06) for mob in targets],
                run_time=0.45,
            )
        self.clear()

    def add_progress(self) -> VGroup:
        # The course is a continuous animation, not a slide deck.
        return VGroup()

    def lesson_intro(self, title: str, explainer: str) -> None:
        """Open each standalone lesson with a compact OpenPond identity beat."""
        icon_path = (
            Path(__file__).resolve().parents[4]
            / "apps"
            / "web"
            / "public"
            / "openpond-icon.png"
        )
        mark = ImageMobject(str(icon_path))
        mark.set_height(1.18)
        wordmark = text("OpenPond", size=38, color=INK, weight="BOLD")
        identity = Group(mark, wordmark).arrange(RIGHT, buff=-0.06).move_to(ORIGIN)

        title_mob = fit_width(text(title, size=55, color=INK, weight="BOLD"), 12.0)
        explainer_mob = fit_width(text(explainer, size=25, color=MUTED), 11.6)
        rule = Line(LEFT * 4.35, RIGHT * 4.35, color=self.chapter_color, stroke_width=2.5)
        lesson_copy = VGroup(title_mob, rule, explainer_mob).arrange(DOWN, buff=0.30)
        lesson_copy.move_to(DOWN * 0.15)

        self.play(FadeIn(mark, scale=0.92), run_time=0.35)
        self.wait(0.18)
        for glyph in wordmark:
            self.play(FadeIn(glyph, shift=LEFT * 0.05), run_time=0.06)
            self.wait(0.02)
        self.wait(0.12)
        self.play(identity.animate.scale(0.62).move_to(UP * 2.55), run_time=0.50)
        self.reveal(title_mob, run_time=0.45)
        self.play(ShowCreation(rule), run_time=0.32)
        self.reveal(explainer_mob, run_time=0.35)
        self.wait(0.82)
        self.wipe()

    def title_card(
        self,
        title: str,
        subtitle: str,
        section: str,
        *,
        applies_to: tuple[str, ...] = (),
    ) -> None:
        marker = chapter_marker(self.chapter_number, section, self.chapter_color)
        marker.to_edge(UP, buff=0.65).to_edge(LEFT, buff=0.8)
        heading = course_title(title, subtitle, section)
        heading.to_edge(LEFT, buff=0.8).shift(DOWN * 0.25)
        rule = Line(
            LEFT * 6.3,
            RIGHT * 6.3,
            color=self.chapter_color,
            stroke_width=2.5,
        )
        rule.next_to(heading, DOWN, buff=0.45).align_to(heading, LEFT)
        self.reveal(marker, heading)
        self.play(ShowCreation(rule), run_time=0.7)
        if applies_to:
            label = text("APPLIES TO", size=16, color=MUTED, weight="BOLD")
            methods = VGroup(
                *[
                    pill(name, self.chapter_color, width=max(1.25, 0.11 * len(name)))
                    for name in applies_to
                ]
            ).arrange(RIGHT, buff=0.18)
            scope = VGroup(label, methods).arrange(RIGHT, buff=0.28)
            scope.next_to(rule, DOWN, buff=0.30).align_to(rule, LEFT)
            self.reveal(scope, run_time=0.55)
        self.hold(2.0)
        self.wipe()

    def heading(
        self,
        title: str,
        section: str,
        *,
        subtitle: str | None = None,
    ) -> VGroup:
        return slide_heading(
            title,
            section,
            subtitle=subtitle,
            accent_color=self.chapter_color,
        )

    def concept_card(
        self,
        term: str,
        expansion: str,
        statement: str,
        distinction: str,
    ) -> None:
        """Give a major term a quiet definition beat before its mechanism."""
        name = fit_width(
            text(term, size=96, color=self.chapter_color, weight="BOLD"),
            11.8,
        )
        full_name = fit_width(text(expansion, size=30, color=INK, weight="BOLD"), 11.4)
        rule = Line(
            LEFT * 4.7,
            RIGHT * 4.7,
            color=self.chapter_color,
            stroke_width=2.5,
        )
        meaning = fit_width(text(statement, size=29, color=INK), 11.4)
        boundary = fit_width(text(distinction, size=22, color=MUTED), 11.4)

        name.move_to(UP * 1.65)
        full_name.next_to(name, DOWN, buff=0.30)
        rule.next_to(full_name, DOWN, buff=0.42)
        meaning.next_to(rule, DOWN, buff=0.50)
        boundary.next_to(meaning, DOWN, buff=0.34)

        self.reveal(name, run_time=0.7)
        self.hold(0.65)
        self.reveal(full_name, run_time=0.55)
        self.play(ShowCreation(rule), run_time=0.55)
        self.hold(0.40)
        self.reveal(meaning, boundary, run_time=0.65)
        self.hold(1.20)
        self.wipe()

    def part_card(self, number: str, title: str, subtitle: str) -> None:
        part = text(number, size=22, color=MUTED, weight="BOLD")
        name = fit_width(
            text(title, size=76, color=self.chapter_color, weight="BOLD"),
            11.8,
        )
        description = fit_width(text(subtitle, size=28, color=INK), 11.2)
        rule = Line(
            LEFT * 4.8,
            RIGHT * 4.8,
            color=self.chapter_color,
            stroke_width=2.5,
        )
        group = VGroup(part, name, rule, description).arrange(
            DOWN,
            buff=0.34,
        )
        group.move_to(ORIGIN)
        self.reveal(part, name, run_time=0.75)
        self.play(ShowCreation(rule), run_time=0.55)
        self.reveal(description, run_time=0.65)
        self.hold(1.35)
        self.wipe()

    def application_card(
        self,
        term: str,
        applications: tuple[str, ...],
        poor_fit: tuple[str, ...],
    ) -> None:
        heading = self.heading(f"{term} in practice", term)
        applies = panel(
            "APPLIES TO",
            applications,
            color=GREEN,
            width=5.35,
            height=3.85,
            title_size=24,
            body_size=20,
        )
        avoid = panel(
            "POOR FIT",
            poor_fit,
            color=CORAL,
            width=5.35,
            height=3.85,
            title_size=24,
            body_size=20,
        )
        pair = VGroup(applies, avoid).arrange(RIGHT, buff=0.70)
        pair.move_to(DOWN * 0.15)
        self.reveal(heading)
        self.play(
            FadeIn(applies, shift=RIGHT * 0.10),
            FadeIn(avoid, shift=LEFT * 0.10),
            run_time=1.25,
        )
        self.hold(2.0)
        self.wipe()

    def source(
        self,
        citation: str,
        *,
        label: str = "SOURCE",
    ) -> None:
        # Sources remain in the study script and narration. The former footer
        # strip was removed to reclaim vertical space for equations and graphs.
        return None

    def sentence(
        self,
        value: str,
        *,
        size: int = 27,
        color: str = INK,
        width: float = 11.7,
    ) -> Text:
        return fit_width(text(value, size=size, color=color), width)

    def conclusion(self, value: str, *, width: float = 11.8) -> VGroup:
        result = callout(value, color=self.chapter_color, width=width, size=24)
        result.to_edge(DOWN, buff=0.38)
        return result
