"""Chapter 7: OPSD, SDFT, SDPO, and routed variants."""

from manimlib import *

from components import (
    BarDatum,
    arrow_between,
    bar_chart,
    line_graph,
    node,
    panel,
    pill,
    plot_frame,
    text,
)
from course_base import LessonScene
from theme import BLUE, CORAL, GREEN, GRID, INK, MUTED, PINK, VIOLET


class Chapter07Methods(LessonScene):
    chapter_number = 8
    chapter_color = PINK

    def construct(self) -> None:
        self._shared_skeleton()
        self._conditioning_equation()
        self._opsd()
        self._sdft()
        self._sdpo()
        self._comparison()
        self._failure_modes()

    def _shared_skeleton(self) -> None:
        heading = self.heading(
            "One failed patch, two views",
            "Self-distillation methods",
            subtitle="The student's cancellation attempt stays fixed; only the teacher's extra evidence changes.",
        )
        student = node(
            "Student samples\nreturn None",
            color=BLUE,
            width=2.25,
            height=1.1,
        )
        prefix = node(
            "Same cancellation\nprefix y<t",
            color=BLUE,
            width=2.25,
            height=1.1,
        )
        teacher = node(
            "Same-model teacher\n+ extra context",
            color=VIOLET,
            width=2.65,
            height=1.1,
        )
        target = node(
            "Teacher token\ndistribution",
            color=VIOLET,
            width=2.3,
            height=1.1,
        )
        update = node("Update student", color=GREEN, width=2.1, height=1.05)
        flow = VGroup(student, prefix, teacher, target, update)
        flow.arrange(RIGHT, buff=0.36).move_to(UP * 0.65)
        arrows = VGroup(
            *[
                arrow_between(flow[index], flow[index + 1])
                for index in range(len(flow) - 1)
            ]
        )
        extras = VGroup(
            pill("OPSD · verified solution", VIOLET, width=2.6),
            pill("SDFT · demonstration", BLUE, width=2.45),
            pill("SDPO · failure feedback", GREEN, width=2.6),
        ).arrange(RIGHT, buff=0.35)
        extras.next_to(teacher, DOWN, buff=0.75)
        brace = Line(
            extras.get_left() + DOWN * 0.20,
            extras.get_right() + DOWN * 0.20,
            color=MUTED,
            stroke_width=2,
        )
        note = text(
            "Only this information channel changes",
            size=19,
            color=MUTED,
            weight="BOLD",
        )
        note.next_to(brace, DOWN, buff=0.12)
        self.reveal(heading, student)
        for index, arrow in enumerate(arrows):
            self.play(ShowCreation(arrow), FadeIn(flow[index + 1]), run_time=0.67)
        self.reveal(extras, brace, note)
        self.source("Unified same-weight, richer-context view", label="METHOD FAMILY")
        self.hold(4.5)
        self.wipe()

    def _conditioning_equation(self) -> None:
        heading = self.heading(
            "Teacher conditioning",
            "Self-distillation methods",
            subtitle="Both distributions score the same next token at the same student-generated prefix.",
        )
        student = panel(
            "STUDENT DISTRIBUTION",
            ["pθ(v | x, y<t)", "deployment-visible context", "receives the gradient"],
            color=BLUE,
            width=4.25,
            height=2.75,
            body_size=21,
        )
        teacher = panel(
            "FROZEN TEACHER TARGET",
            ["q(v | x, y<t, e)", "same prefix + evidence e", "supplies dense probabilities"],
            color=VIOLET,
            width=4.25,
            height=2.75,
            body_size=21,
        )
        pair = VGroup(student, teacher).arrange(RIGHT, buff=1.55)
        pair.move_to(UP * 0.45)
        arrow = Arrow(
            teacher.get_left(),
            student.get_right(),
            color=VIOLET,
            buff=0.18,
            stroke_width=4,
        )
        loss = pill("minimize KL(q || pθ)", PINK, width=2.75)
        loss.next_to(arrow, DOWN, buff=0.18)
        evidence = VGroup(
            pill("e = verified solution  →  OPSD", VIOLET, width=3.35),
            pill("e = demonstration  →  SDFT", BLUE, width=3.35),
            pill("e = failure feedback  →  SDPO", GREEN, width=3.35),
        ).arrange(RIGHT, buff=0.25)
        evidence.next_to(pair, DOWN, buff=0.62)
        self.reveal(heading, student, teacher)
        self.play(ShowCreation(arrow), FadeIn(loss), run_time=0.8)
        self.play(
            LaggedStart(*[FadeIn(item) for item in evidence], lag_ratio=0.12),
            run_time=0.8,
        )
        self.hold(1.35)
        self.wipe()

    def _opsd(self) -> None:
        heading = self.heading(
            "Verified-solution guidance",
            "OPSD · On-Policy Self-Distillation",
            subtitle="A verified repair guides the teacher while remaining hidden from the deployed student.",
        )
        problem = panel(
            "STUDENT VIEW",
            [
                "fix cancellation bug",
                "student prefix: if cancelled:",
                "no privileged repair",
            ],
            width=3.55,
            height=3.0,
            color=BLUE,
            body_size=19,
        )
        solution = panel(
            "PRIVILEGED SOLUTION",
            [
                "raise CancelledError()",
                "preserve cleanup path",
                "verified by full tests",
            ],
            width=3.65,
            height=3.0,
            color=VIOLET,
            body_size=19,
        )
        teacher = panel(
            "TEACHER TARGET",
            [
                "same prefix",
                "solution-conditioned logits",
                "dense token guidance",
            ],
            width=3.4,
            height=3.0,
            color=VIOLET,
            body_size=19,
        )
        flow = VGroup(problem, solution, teacher).arrange(RIGHT, buff=0.48)
        flow.move_to(DOWN * 0.05)
        plus = text("+", size=38, color=MUTED, weight="BOLD")
        arrow = arrow_between(solution, teacher)
        plus.move_to((problem.get_right() + solution.get_left()) / 2)
        guard = self.conclusion(
            "The verified solution is teacher-only and absent from the deployment-time student prompt."
        )
        paper = pill("PAPER · SELF-DISTILLED REASONER · 2601.18734", MUTED, width=4.5)
        paper.next_to(teacher, UP, buff=0.28)
        self.reveal(heading, problem)
        self.play(FadeIn(plus), FadeIn(solution), run_time=0.9)
        self.play(ShowCreation(arrow), FadeIn(teacher), run_time=1.0)
        self.reveal(paper, guard)
        self.source("Self-Distilled Reasoner · arXiv:2601.18734", label="OPSD")
        self.hold(4.6)
        self.wipe()

    def _sdft(self) -> None:
        heading = self.heading(
            "Demonstration guidance",
            "SDFT · Self-Distillation Fine-Tuning",
            subtitle="A related expert repair guides the student's own cancellation prefix.",
        )
        demo = panel(
            "EXPERT DEMONSTRATION",
            [
                "inspect cancellation flag",
                "run cleanup",
                "raise CancelledError()",
            ],
            width=3.65,
            height=3.1,
            color=BLUE,
            body_size=19,
        )
        student = panel(
            "STUDENT'S OWN PREFIX",
            [
                "finds the right branch",
                "uses a different order",
                "adds return None",
            ],
            width=3.65,
            height=3.1,
            color=BLUE,
            body_size=19,
        )
        target = panel(
            "DEMO-CONDITIONED TEACHER",
            [
                "scores the student's state",
                "raises exception tokens",
                "preserves valid alternatives",
            ],
            width=3.75,
            height=3.1,
            color=VIOLET,
            body_size=18,
        )
        flow = VGroup(demo, student, target).arrange(RIGHT, buff=0.43)
        flow.move_to(DOWN * 0.05)
        arrows = VGroup(arrow_between(demo, student), arrow_between(student, target))
        self.reveal(heading, demo)
        self.play(ShowCreation(arrows[0]), FadeIn(student), run_time=0.9)
        self.play(ShowCreation(arrows[1]), FadeIn(target), run_time=0.9)
        lesson = self.conclusion(
            "Offline imitation follows demonstration prefixes; SDFT guides prefixes generated by the current student."
        )
        paper = pill("PAPER · CONTINUAL LEARNING · 2601.19897", MUTED, width=4.35)
        paper.next_to(target, UP, buff=0.28)
        self.reveal(paper, lesson)
        self.source("Self-Distillation Enables Continual Learning · arXiv:2601.19897", label="SDFT")
        self.hold(4.7)
        self.wipe()

    def _sdpo(self) -> None:
        heading = self.heading(
            "Failure-guided correction",
            "SDPO · Self-Distillation Policy Optimization",
            subtitle="The feedback explains the current student's failed trajectory.",
        )
        attempt = panel(
            "STUDENT ATTEMPT",
            [
                "adds timeout return",
                "tests: 8 pass, 1 fails",
                "scalar reward = 0",
            ],
            width=3.5,
            height=3.0,
            color=BLUE,
            body_size=19,
        )
        feedback = panel(
            "RICH FEEDBACK",
            [
                "test_cancel failed",
                "expected CancelledError",
                "return skipped cancellation",
            ],
            width=3.8,
            height=3.0,
            color=GREEN,
            body_size=19,
        )
        teacher = panel(
            "FEEDBACK-CONDITIONED TEACHER",
            [
                "same failed prefix",
                "raises cancellation tokens",
                "dense corrective signal",
            ],
            width=3.8,
            height=3.0,
            color=VIOLET,
            body_size=18,
        )
        flow = VGroup(attempt, feedback, teacher).arrange(RIGHT, buff=0.42)
        flow.move_to(DOWN * 0.05)
        arrows = VGroup(arrow_between(attempt, feedback), arrow_between(feedback, teacher))
        self.reveal(heading, attempt)
        self.play(ShowCreation(arrows[0]), FadeIn(feedback), run_time=0.9)
        self.play(ShowCreation(arrows[1]), FadeIn(teacher), run_time=0.9)
        lesson = self.conclusion(
            "A failed rollout can contain more corrective information than a successful one."
        )
        paper = pill("PAPER · RL VIA SELF-DISTILLATION · 2601.20802", MUTED, width=4.55)
        paper.next_to(teacher, UP, buff=0.28)
        self.reveal(paper, lesson)
        self.source("Reinforcement Learning via Self-Distillation · arXiv:2601.20802", label="SDPO")
        self.hold(4.7)
        self.wipe()

    def _comparison(self) -> None:
        heading = self.heading(
            "Choose by evidence",
            "Self-distillation methods",
        )
        labels = VGroup(
            text("METHOD", size=17, color=MUTED, weight="BOLD"),
            text("TEACHER GETS", size=17, color=MUTED, weight="BOLD"),
            text("BEST FIT", size=17, color=MUTED, weight="BOLD"),
            text("PRIMARY RISK", size=17, color=MUTED, weight="BOLD"),
        )
        rows = [
            ("OPSD", "verified solution", "exact reasoning", "answer leakage"),
            ("SDFT", "demonstration", "knowledge / tools", "forgetting"),
            ("SDPO", "failure feedback", "code / agents", "noisy dense drift"),
        ]
        rendered_rows = VGroup()
        for method, evidence, fit, risk in rows:
            rendered_rows.add(
                VGroup(
                    text(method, size=20, color=INK, weight="BOLD"),
                    text(evidence, size=19, color=INK),
                    text(fit, size=19, color=INK),
                    text(risk, size=19, color=INK),
                )
            )
        column_x = [-4.8, -1.85, 1.65, 4.65]
        for mob, x in zip(labels, column_x):
            mob.move_to(RIGHT * x + UP * 1.55)
        for row_index, row in enumerate(rendered_rows):
            y = 0.65 - row_index * 1.12
            for mob, x in zip(row, column_x):
                mob.move_to(RIGHT * x + UP * y)
        rules = VGroup(
            *[
                Line(LEFT * 5.9, RIGHT * 5.9, color=GRID, stroke_width=1)
                .move_to(UP * y)
                for y in [1.15, 0.05, -1.07, -2.18]
            ]
        )
        self.reveal(heading, labels)
        self.play(ShowCreation(rules), run_time=0.8)
        self.play(
            LaggedStart(*[FadeIn(row) for row in rendered_rows], lag_ratio=0.18),
            run_time=1.4,
        )
        self.source("Dataset schema should preserve each method's information boundary", label="DECISION TABLE")
        self.hold(4.8)
        self.wipe()

    def _reported_results(self) -> None:
        heading = self.heading(
            "Different paper claims",
            "Self-distillation methods",
            subtitle="Read each result inside its own model, data, and evaluation setup.",
        )
        left_title = text("SDFT · KNOWLEDGE ACQUISITION", size=17, color=INK, weight="BOLD")
        left = bar_chart(
            [
                BarDatum("imitation strict", 80, MUTED),
                BarDatum("SDFT strict", 89, BLUE),
                BarDatum("imitation OOD", 80, MUTED),
                BarDatum("SDFT OOD", 98, BLUE),
            ],
            max_value=100,
            width=5.2,
            height=3.25,
            value_suffix="",
            value_decimals=0,
        )
        right_title = text("SDPO · LIVECODEBENCH V6", size=17, color=INK, weight="BOLD")
        right = bar_chart(
            [
                BarDatum("GRPO", 41.2, MUTED),
                BarDatum("SDPO", 48.8, GREEN),
            ],
            max_value=55,
            width=4.3,
            height=3.25,
            value_suffix="",
            value_decimals=1,
        )
        left.move_to(LEFT * 3.25 + DOWN * 0.2)
        right.move_to(RIGHT * 3.3 + DOWN * 0.2)
        left_title.next_to(left, UP, buff=0.15)
        right_title.next_to(right, UP, buff=0.15)
        self.reveal(heading)
        self.play(
            FadeIn(VGroup(left, left_title), shift=UP * 0.1),
            FadeIn(VGroup(right, right_title), shift=UP * 0.1),
            run_time=1.6,
        )
        caution = self.conclusion(
            "These are reported paper results—not a controlled head-to-head comparison between methods."
        )
        self.reveal(caution)
        self.source("SDFT 2601.19897 · SDPO 2601.20802", label="PAPER RESULTS")
        self.hold(4.8)
        self.wipe()

    def _opsd_scaling_results(self) -> None:
        heading = self.heading(
            "OPSD scaling result",
            "Self-distillation methods",
            subtitle="Aggregate score across the paper's evaluated reasoning tasks.",
        )
        frame = plot_frame(
            x_label="MODEL SIZE  ·  1.7B              4B              8B",
            y_label="REPORTED AGGREGATE  ·  30 TO 70",
            width=9.2,
            height=4.0,
        )
        frame.group.shift(DOWN * 0.35)
        frame.origin += DOWN * 0.35

        def score(value: float) -> float:
            return (value - 30.0) / 40.0

        xs = [0.14, 0.5, 0.86]
        base_values = [37.1, 61.2, 61.8]
        grpo_values = [37.7, 62.7, 64.0]
        opsd_values = [43.4, 63.6, 64.8]
        base = line_graph(
            frame,
            list(zip(xs, [score(value) for value in base_values])),
            color=CORAL,
            stroke_width=3,
        )
        grpo = line_graph(
            frame,
            list(zip(xs, [score(value) for value in grpo_values])),
            color=MUTED,
            stroke_width=4,
        )
        opsd = line_graph(
            frame,
            list(zip(xs, [score(value) for value in opsd_values])),
            color=INK,
            stroke_width=5,
        )
        dots = VGroup()
        for values, color in [
            (base_values, CORAL),
            (grpo_values, MUTED),
            (opsd_values, INK),
        ]:
            for x, value in zip(xs, values):
                point = Dot(frame.point(x, score(value)), radius=0.075, color=color)
                value_label = text(
                    f"{value:.1f}",
                    size=15,
                    color=color,
                    weight="BOLD",
                )
                value_label.next_to(point, UP, buff=0.06)
                dots.add(VGroup(point, value_label))
        labels = VGroup(
            pill("BASE", CORAL, width=1.15),
            pill("GRPO", MUTED, width=1.25),
            pill("OPSD", INK, width=1.25),
        ).arrange(RIGHT, buff=0.22)
        labels.move_to(frame.point(0.25, 0.9))
        self.reveal(heading, frame.group, labels)
        self.play(ShowCreation(base), run_time=0.9)
        self.play(ShowCreation(grpo), run_time=0.9)
        self.play(ShowCreation(opsd), run_time=0.9)
        self.play(
            LaggedStart(*[FadeIn(dot) for dot in dots], lag_ratio=0.06),
            run_time=1.2,
        )
        self.source("Self-Distilled Reasoner · arXiv:2601.18734", label="REPORTED RESULT")
        self.hold(4.8)
        self.wipe()

    def _routing(self) -> None:
        heading = self.heading(
            "Route by outcome",
            "Self-distillation methods",
            subtitle="The most informative signal depends on what happened in the rollout.",
        )
        rollout = node("Student rollout", width=2.2)
        verifier = node("Verifier", width=1.8)
        rollout.move_to(LEFT * 4.4 + UP * 0.3)
        verifier.move_to(LEFT * 1.65 + UP * 0.3)
        success = panel(
            "SUCCESS",
            ["outcome reward", "GRPO-style selection"],
            width=3.15,
            height=2.15,
            color=INK,
            body_size=19,
        )
        failure = panel(
            "FAILURE + EXPLANATION",
            ["rich feedback", "SDPO-style correction"],
            width=3.45,
            height=2.15,
            color=INK,
            body_size=18,
        )
        success.move_to(RIGHT * 3.05 + UP * 1.25)
        failure.move_to(RIGHT * 3.05 + DOWN * 1.3)
        first = arrow_between(rollout, verifier)
        branches = VGroup(
            Arrow(verifier.get_right(), success.get_left(), buff=0.14, color=INK),
            Arrow(verifier.get_right(), failure.get_left(), buff=0.14, color=MUTED),
        )
        result = self.conclusion(
            "Routing uses sparse evidence when it is enough and dense correction when failure exposes more."
        )
        self.reveal(heading, rollout)
        self.play(ShowCreation(first), FadeIn(verifier), run_time=0.8)
        self.play(
            ShowCreation(branches[0]),
            ShowCreation(branches[1]),
            FadeIn(success),
            FadeIn(failure),
            run_time=1.3,
        )
        self.reveal(result)
        self.source("Sample-Routed Policy Optimization · arXiv:2604.02288", label="SRPO")
        self.hold(4.6)
        self.wipe()

    def _failure_modes(self) -> None:
        heading = self.heading(
            "Dense-feedback risks",
            "Self-distillation methods",
            subtitle="More gradient is useful only when the teacher view is trustworthy.",
        )
        risks = VGroup(
            panel(
                "LEAKAGE",
                ["privileged answer reaches student", "evaluation becomes invalid"],
                width=3.6,
                height=2.35,
                color=INK,
                body_size=18,
            ),
            panel(
                "TEACHER ERROR",
                ["bad context densifies mistakes", "confidence hides uncertainty"],
                width=3.6,
                height=2.35,
                color=INK,
                body_size=18,
            ),
            panel(
                "FORGETTING",
                ["new domain improves", "unrelated abilities regress"],
                width=3.6,
                height=2.35,
                color=INK,
                body_size=18,
            ),
            panel(
                "COLLAPSE",
                ["entropy falls", "one mode dominates"],
                width=3.6,
                height=2.35,
                color=INK,
                body_size=18,
            ),
            panel(
                "STALE TEACHER",
                ["student moves", "fixed targets lose relevance"],
                width=3.6,
                height=2.35,
                color=INK,
                body_size=18,
            ),
            panel(
                "COST BLINDNESS",
                ["teacher forward pass omitted", "unfair efficiency claim"],
                width=3.6,
                height=2.35,
                color=INK,
                body_size=18,
            ),
        )
        risks.arrange_in_grid(n_rows=2, n_cols=3, h_buff=0.35, v_buff=0.35)
        risks.move_to(DOWN * 0.35)
        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(card) for card in risks], lag_ratio=0.1),
            run_time=1.7,
        )
        self.source("Denser Is Not Better · arXiv:2607.01763", label="COUNTEREVIDENCE")
        self.hold(4.8)
        self.wipe()
