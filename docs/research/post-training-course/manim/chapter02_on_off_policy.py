"""Chapter 2: the minimum useful distinction between on- and off-policy data."""

from manimlib import *

from components import arrow_between, node, panel, text
from course_base import LessonScene
from theme import AMBER, BLUE, CYAN, GREEN, INK, MONO_FONT, MUTED, VIOLET


class Chapter02OnOffPolicy(LessonScene):
    chapter_number = 3
    chapter_color = BLUE
    hold_scale = 5.0

    def construct(self) -> None:
        self.lesson_intro(
            "On-policy and off-policy data",
            "The data source determines which update a training record can support.",
        )
        self._source_definition()
        self._rollout_record()
        self._stored_signals()
        self._method_routing()

    def _source_definition(self) -> None:
        heading = self.heading(
            "On-policy or off-policy?",
            "Data source",
            subtitle="The label depends on who generated the training attempt.",
        )

        on_generator = node(
            "policy v12\nbeing trained",
            color=CYAN,
            width=2.65,
            height=1.1,
            size=19,
        )
        on_attempt = node(
            "raise CancelledError()\nreward 1",
            color=GREEN,
            width=3.15,
            height=1.1,
            size=18,
        )
        on_flow = VGroup(on_generator, on_attempt).arrange(RIGHT, buff=0.48)

        off_generator = node(
            "teacher · human\nor policy v8",
            color=VIOLET,
            width=2.65,
            height=1.1,
            size=19,
        )
        off_attempt = node(
            "return None\nreward 0 · stored",
            color=AMBER,
            width=3.15,
            height=1.1,
            size=18,
        )
        off_flow = VGroup(off_generator, off_attempt).arrange(RIGHT, buff=0.48)

        rows = VGroup(on_flow, off_flow).arrange(DOWN, buff=0.72, aligned_edge=LEFT)
        rows.move_to(LEFT * 0.9 + DOWN * 0.15)
        arrows = VGroup(
            arrow_between(on_generator, on_attempt, color=CYAN),
            arrow_between(off_generator, off_attempt, color=VIOLET),
        )
        on_label = text("on-policy for v12", size=20, color=GREEN, weight="BOLD")
        off_label = text("off-policy for v12", size=20, color=AMBER, weight="BOLD")
        on_label.next_to(on_attempt, RIGHT, buff=0.35)
        off_label.next_to(off_attempt, RIGHT, buff=0.35)
        takeaway = self.conclusion(
            "On-policy means the learner generated the attempt; off-policy means another source did."
        )

        self.reveal(heading, on_generator, off_generator)
        self.play(
            ShowCreation(arrows[0]),
            FadeIn(on_attempt),
            FadeIn(on_label),
            run_time=0.9,
        )
        self.play(
            ShowCreation(arrows[1]),
            FadeIn(off_attempt),
            FadeIn(off_label),
            run_time=0.9,
        )
        self.reveal(takeaway)
        self.hold(2.15)
        self.wipe()

    def _rollout_record(self) -> None:
        heading = self.heading(
            "A rollout is a record",
            "Data source",
            subtitle="RL training preserves the attempt, its probability, and the result.",
        )
        issue = node("issue + repo", color=BLUE, width=2.0)
        policy = node("policy v12", color=CYAN, width=1.85)
        patch = node("raise error", color=GREEN, width=1.9)
        tests = node("run tests", color=INK, width=1.8)
        reward = node("reward 1", color=GREEN, width=1.75)
        flow = VGroup(issue, policy, patch, tests, reward).arrange(RIGHT, buff=0.34)
        flow.move_to(UP * 0.85)
        arrows = VGroup(
            *[
                arrow_between(flow[index], flow[index + 1], buff=0.10)
                for index in range(len(flow) - 1)
            ]
        )

        record = panel(
            "ROLLOUT RECORD",
            [
                "behavior policy: v12",
                "sampled action: raise CancelledError()",
                "behavior log-probability: −3.1",
                "test observation + terminal reward: 1",
            ],
            color=CYAN,
            width=7.7,
            height=2.35,
            title_size=22,
            body_size=18,
        )
        record.move_to(DOWN * 1.35)
        store_arrow = Arrow(
            reward.get_bottom(),
            record.get_top(),
            buff=0.12,
            color=CYAN,
            stroke_width=3,
        )
        takeaway = self.conclusion(
            "A final response without its generator, probabilities, and outcome is not an RL rollout."
        )

        self.reveal(heading, issue)
        for index, arrow in enumerate(arrows):
            self.play(ShowCreation(arrow), FadeIn(flow[index + 1]), run_time=0.5)
        self.play(ShowCreation(store_arrow), FadeIn(record), run_time=0.8)
        self.reveal(takeaway)
        self.hold(2.1)
        self.wipe()

    def _stored_signals(self) -> None:
        heading = self.heading(
            "Stored data trains differently",
            "Data source",
            subtitle="The available fields determine which learning objective a row can support.",
        )
        demonstration = panel(
            "TEACHER EXAMPLE",
            [
                "prompt + expert patch",
                "target tokens or logits",
                "imitation or distillation",
            ],
            color=VIOLET,
            width=3.55,
            height=3.1,
            body_size=18,
        )
        preference = panel(
            "PREFERENCE PAIR",
            [
                "raise error > return None",
                "chosen + rejected patches",
                "relative preference loss",
            ],
            color=BLUE,
            width=3.55,
            height=3.1,
            body_size=18,
        )
        old_rollout = panel(
            "OLD RL ROLLOUT",
            [
                "actions + old log-probability",
                "observations + reward",
                "corrected or replayed update",
            ],
            color=AMBER,
            width=3.55,
            height=3.1,
            body_size=18,
        )
        cards = VGroup(demonstration, preference, old_rollout).arrange(RIGHT, buff=0.45)
        cards.move_to(DOWN * 0.15)
        takeaway = self.conclusion(
            "Off-policy is a source description, not a quality judgment."
        )

        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(card) for card in cards], lag_ratio=0.18),
            run_time=1.35,
        )
        self.reveal(takeaway)
        self.hold(2.25)
        self.wipe()

    def _method_routing(self) -> None:
        heading = self.heading(
            "Source changes the update",
            "Data source",
            subtitle="Current attempts and stored examples carry different training signals.",
        )
        methods = VGroup(
            panel(
                "PPO / GRPO",
                ["learner generates attempts", "environment supplies reward"],
                color=CYAN,
                width=3.55,
                height=2.4,
                body_size=18,
            ),
            panel(
                "OFFLINE DISTILLATION",
                ["teacher supplies examples", "student predicts teacher targets"],
                color=VIOLET,
                width=3.55,
                height=2.4,
                body_size=18,
            ),
            panel(
                "ON-POLICY DISTILLATION",
                ["student supplies its prefix", "teacher labels that exact state"],
                color=GREEN,
                width=3.75,
                height=2.4,
                body_size=18,
            ),
        ).arrange(RIGHT, buff=0.38)
        methods.move_to(DOWN * 0.05)
        signal = text(
            "A rollout contains actions, observations, probabilities, and reward—not only a final patch.",
            size=23,
            color=INK,
            weight="BOLD",
        )
        signal.to_edge(DOWN, buff=0.68)

        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(method) for method in methods], lag_ratio=0.18),
            run_time=1.35,
        )
        self.reveal(signal)
        self.hold(2.35)
        self.wipe()
