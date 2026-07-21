"""Reusable ManimGL components for the post-training course."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np
from manimlib import *

from theme import (
    AMBER,
    BACKGROUND,
    BLUE,
    BODY_SIZE,
    CORAL,
    CYAN,
    FONT,
    FOOTER_SIZE,
    FRAME_H,
    FRAME_W,
    GREEN,
    GRID,
    INK,
    MONO_FONT,
    MUTED,
    PINK,
    SMALL_SIZE,
    SUBTITLE_SIZE,
    SURFACE,
    SURFACE_2,
    TITLE_SIZE,
    VIOLET,
)


def text(
    value: str,
    *,
    size: int = BODY_SIZE,
    color: str = INK,
    weight: str = "NORMAL",
    font: str = FONT,
) -> Text:
    return Text(value, font=font, font_size=size, color=color, weight=weight)


def fit_width(mob: Mobject, width: float) -> Mobject:
    if mob.get_width() > width:
        mob.set_width(width)
    return mob


def course_title(
    title: str,
    subtitle: str,
    section: str,
    *,
    title_color: str = INK,
) -> VGroup:
    eyebrow = text(section.upper(), size=SMALL_SIZE, color=MUTED, weight="BOLD")
    heading = fit_width(
        text(title, size=TITLE_SIZE, color=title_color, weight="BOLD"),
        12.6,
    )
    subheading = fit_width(text(subtitle, size=SUBTITLE_SIZE, color=MUTED), 12.0)
    group = VGroup(eyebrow, heading, subheading)
    group.arrange(DOWN, aligned_edge=LEFT, buff=0.18)
    return group


def slide_heading(
    title: str,
    section: str,
    *,
    subtitle: str | None = None,
    accent_color: str = CYAN,
) -> VGroup:
    heading = fit_width(text(title, size=40, color=INK, weight="BOLD"), 12.4)
    items: list[Mobject] = [heading]
    if subtitle:
        items.append(fit_width(text(subtitle, size=21, color=MUTED), 12.4))
    title_block = VGroup(*items).arrange(DOWN, aligned_edge=LEFT, buff=0.12)
    title_block.to_edge(UP, buff=0.42).to_edge(LEFT, buff=0.7)

    # Keep the hierarchy quiet: one title, one optional explanatory line, and
    # a small contextual label outside the main reading path.
    label = fit_width(text(section, size=14, color=accent_color), 2.8)
    label.to_corner(DR, buff=0.28)
    return VGroup(title_block, label)


def pill(label: str, color: str = CYAN, *, width: float | None = None) -> VGroup:
    label_mob = text(label, size=SMALL_SIZE, color=color, weight="BOLD")
    rect_width = max(label_mob.get_width() + 0.45, width or 0)
    background = RoundedRectangle(
        width=rect_width,
        height=0.48,
        corner_radius=0.08,
        stroke_width=0,
        fill_color=BACKGROUND,
        fill_opacity=0.92,
    )
    label_mob.move_to(background)
    return VGroup(background, label_mob)


def panel(
    title: str,
    lines: Sequence[str],
    *,
    width: float = 4.0,
    height: float = 3.6,
    color: str = CYAN,
    title_size: int = 27,
    body_size: int = 21,
) -> VGroup:
    bounds = Rectangle(
        width=width,
        height=height,
        stroke_width=0,
        fill_opacity=0,
    )
    guide = Line(
        bounds.get_corner(UL) + RIGHT * 0.12 + DOWN * 0.12,
        bounds.get_corner(DL) + RIGHT * 0.12 + UP * 0.12,
        color=color,
        stroke_width=3,
    )
    heading = fit_width(
        text(title, size=title_size, color=color, weight="BOLD"),
        width - 0.62,
    )
    bullets = VGroup(
        *[
            fit_width(
                text(f"•  {line}", size=body_size, color=INK),
                width - 0.68,
            )
            for line in lines
        ]
    )
    bullets.arrange(DOWN, aligned_edge=LEFT, buff=0.2)
    content = VGroup(heading, bullets).arrange(
        DOWN,
        aligned_edge=LEFT,
        buff=0.3,
    )
    content.move_to(bounds)
    content.align_to(bounds, LEFT).shift(RIGHT * 0.36)
    return VGroup(bounds, guide, content)


def callout(
    value: str,
    *,
    color: str = AMBER,
    width: float = 11.7,
    size: int = 25,
) -> VGroup:
    label = fit_width(text(value, size=size, color=INK, weight="BOLD"), width - 0.7)
    bounds = Rectangle(
        width=width,
        height=max(0.78, label.get_height() + 0.35),
        stroke_width=0,
        fill_opacity=0,
    )
    label.move_to(bounds).shift(UP * 0.05)
    underline = Line(
        LEFT * min(width * 0.42, label.get_width() * 0.58),
        RIGHT * min(width * 0.42, label.get_width() * 0.58),
        color=color,
        stroke_width=3,
    )
    underline.next_to(label, DOWN, buff=0.12)
    return VGroup(bounds, label, underline)


def source_footer(
    citation: str,
    *,
    label: str = "SOURCE",
    color: str = MUTED,
) -> VGroup:
    tag = text(label, size=FOOTER_SIZE, color=MUTED, weight="BOLD")
    cite = fit_width(text(citation, size=FOOTER_SIZE, color=color), 11.4)
    group = VGroup(tag, cite).arrange(RIGHT, buff=0.2, aligned_edge=DOWN)
    group.to_edge(DOWN, buff=0.24).to_edge(LEFT, buff=0.7)
    return group


def chapter_marker(number: int, title: str, color: str) -> VGroup:
    circle = Circle(
        radius=0.45,
        stroke_color=color,
        stroke_width=2.5,
        fill_opacity=0,
    )
    number_mob = text(str(number), size=26, color=color, weight="BOLD")
    number_mob.move_to(circle)
    label = text(title, size=22, color=INK, weight="BOLD")
    return VGroup(VGroup(circle, number_mob), label).arrange(RIGHT, buff=0.18)


def arrow_between(
    left: Mobject,
    right: Mobject,
    *,
    color: str = MUTED,
    buff: float = 0.16,
) -> Arrow:
    return Arrow(
        left.get_right(),
        right.get_left(),
        buff=buff,
        color=color,
        stroke_width=4,
        tip_width_ratio=4,
    )


def node(
    label: str,
    *,
    color: str = CYAN,
    width: float = 2.25,
    height: float = 0.9,
    size: int = 22,
) -> VGroup:
    background = RoundedRectangle(
        width=width,
        height=height,
        corner_radius=0.08,
        stroke_color=GRID,
        stroke_width=1.25,
        fill_color=SURFACE_2,
        fill_opacity=0.58,
    )
    label_mob = fit_width(
        text(label, size=size, color=color, weight="BOLD"),
        width - 0.35,
    )
    label_mob.move_to(background)
    return VGroup(background, label_mob)


@dataclass(frozen=True)
class BarDatum:
    label: str
    value: float
    color: str


@dataclass
class PlotFrame:
    group: VGroup
    origin: np.ndarray
    width: float
    height: float

    def point(self, x: float, y: float) -> np.ndarray:
        """Map normalized x/y coordinates into the plot rectangle."""
        return self.origin + RIGHT * (x * self.width) + UP * (y * self.height)


def plot_frame(
    *,
    x_label: str,
    y_label: str,
    width: float = 8.4,
    height: float = 4.1,
    ticks: int = 5,
) -> PlotFrame:
    origin = LEFT * (width / 2) + DOWN * (height / 2)
    x_axis = Line(origin, origin + RIGHT * width, color=MUTED, stroke_width=2)
    y_axis = Line(origin, origin + UP * height, color=MUTED, stroke_width=2)
    grid = VGroup()
    for index in range(1, ticks):
        x = index / ticks
        vertical = Line(
            origin + RIGHT * (x * width),
            origin + RIGHT * (x * width) + UP * height,
            color=GRID,
            stroke_width=1,
        )
        horizontal = Line(
            origin + UP * (x * height),
            origin + UP * (x * height) + RIGHT * width,
            color=GRID,
            stroke_width=1,
        )
        grid.add(vertical, horizontal)
    x_copy = text(x_label, size=17, color=MUTED, weight="BOLD")
    x_copy.next_to(x_axis, DOWN, buff=0.18)
    y_copy = text(y_label, size=17, color=MUTED, weight="BOLD")
    y_copy.rotate(PI / 2).next_to(y_axis, LEFT, buff=0.2)
    group = VGroup(grid, x_axis, y_axis, x_copy, y_copy)
    return PlotFrame(group=group, origin=origin, width=width, height=height)


def line_graph(
    frame: PlotFrame,
    points: Sequence[tuple[float, float]],
    *,
    color: str = INK,
    stroke_width: float = 4,
) -> VMobject:
    path = VMobject()
    path.set_points_smoothly([frame.point(x, y) for x, y in points])
    path.set_stroke(color=color, width=stroke_width)
    return path


def bar_chart(
    data: Sequence[BarDatum],
    *,
    max_value: float,
    width: float = 5.5,
    height: float = 3.5,
    value_suffix: str = "",
    value_decimals: int = 1,
) -> VGroup:
    chart = VGroup()
    baseline = Line(ORIGIN, RIGHT * width, color=GRID, stroke_width=2)
    chart.add(baseline)
    slot = width / max(len(data), 1)
    max_bar_height = height - 0.8

    for index, datum in enumerate(data):
        bar_height = max(0.06, (datum.value / max_value) * max_bar_height)
        bar_width = min(0.72, slot * 0.62)
        bar = Rectangle(
            width=bar_width,
            height=bar_height,
            stroke_width=0,
            fill_color=datum.color,
            fill_opacity=0.88,
        )
        bar.move_to(
            baseline.get_left()
            + RIGHT * (slot * (index + 0.5))
            + UP * (bar_height / 2)
        )
        label = fit_width(
            text(datum.label, size=17, color=MUTED, weight="BOLD"),
            slot * 0.9,
        )
        label.next_to(bar, DOWN, buff=0.13)
        value = text(
            f"{datum.value:.{value_decimals}f}{value_suffix}",
            size=18,
            color=INK,
            weight="BOLD",
            font=MONO_FONT,
        )
        value.next_to(bar, UP, buff=0.08)
        chart.add(bar, label, value)

    return chart


def comparison_rows(
    rows: Sequence[tuple[str, str, str]],
    *,
    left_color: str = CYAN,
    right_color: str = VIOLET,
) -> VGroup:
    rendered = VGroup()
    for label, left, right in rows:
        label_mob = fit_width(text(label, size=19, color=MUTED), 2.4)
        left_mob = fit_width(text(left, size=19, color=left_color, weight="BOLD"), 3.7)
        right_mob = fit_width(text(right, size=19, color=right_color, weight="BOLD"), 3.7)
        row = VGroup(label_mob, left_mob, right_mob)
        label_mob.set_width(2.4, stretch=True)
        left_mob.move_to(label_mob.get_right() + RIGHT * 2.15)
        right_mob.move_to(left_mob.get_right() + RIGHT * 2.25)
        rendered.add(row)
    rendered.arrange(DOWN, aligned_edge=LEFT, buff=0.28)
    return rendered


def divider(width: float = 12.7) -> Line:
    return Line(LEFT * width / 2, RIGHT * width / 2, color=GRID, stroke_width=1.5)


def progress_dots(active: int, total: int, color: str = CYAN) -> VGroup:
    dots = VGroup()
    for index in range(total):
        dot = Dot(
            radius=0.045 if index != active else 0.065,
            color=color if index == active else GRID,
        )
        dots.add(dot)
    dots.arrange(RIGHT, buff=0.11)
    dots.to_edge(RIGHT, buff=0.7).to_edge(DOWN, buff=0.3)
    return dots


def signal_legend(items: Iterable[tuple[str, str]]) -> VGroup:
    rendered = VGroup()
    for label, color in items:
        swatch = RoundedRectangle(
            width=0.24,
            height=0.24,
            corner_radius=0.05,
            stroke_width=0,
            fill_color=color,
            fill_opacity=1,
        )
        label_mob = text(label, size=17, color=MUTED)
        rendered.add(VGroup(swatch, label_mob).arrange(RIGHT, buff=0.12))
    rendered.arrange(RIGHT, buff=0.35)
    return rendered
