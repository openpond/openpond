"""Chapter 8: datasets, experiments, compute, and a research program."""

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
from theme import AMBER, BLUE, CORAL, GREEN, GRID, INK, MUTED, VIOLET


class Chapter08Research(LessonScene):
    chapter_number = 9
    chapter_color = AMBER

    def construct(self) -> None:
        self.lesson_intro(
            "Credible experiments",
            "How to build datasets, baselines, and evaluations you can trust.",
        )
        self._task_contract()
        self._hugging_face()
        self._baseline_ladder()
        self._metric_dashboard()
        self._compute_accounting()
        self._three_campaigns()
        self._paper_structure()
        self._closing_map()

    def _task_contract(self) -> None:
        heading = self.heading(
            "From one repair to a study",
            "Credible experiments",
            subtitle="The cancellation example becomes research only when many tasks preserve the same boundaries.",
        )
        visible = panel(
            "POLICY INPUT",
            [
                "issue + repository revision",
                "allowed tools + public tests",
                "deployment-visible context",
            ],
            width=3.5,
            height=2.65,
            color=BLUE,
            body_size=19,
        )
        training = panel(
            "TRAINING-ONLY ASSETS",
            [
                "expert repair demonstration",
                "privileged verified patch",
                "public failure diagnostics",
            ],
            width=3.6,
            height=2.65,
            color=AMBER,
            body_size=19,
        )
        evaluation = panel(
            "EVALUATOR-ONLY",
            [
                "hidden cancellation tests",
                "anti-exploit checks",
                "held-out repository clusters",
            ],
            width=3.5,
            height=2.65,
            color=VIOLET,
            body_size=19,
        )
        cards = VGroup(visible, training, evaluation).arrange(RIGHT, buff=0.45)
        cards.move_to(UP * 0.25)
        fields = VGroup(
            pill("source revision", MUTED, width=1.65),
            pill("license", MUTED, width=1.15),
            pill("split", MUTED, width=1.05),
            pill("cluster ID", MUTED, width=1.35),
            pill("verifier version", MUTED, width=1.75),
            pill("content hash", MUTED, width=1.55),
        ).arrange(RIGHT, buff=0.22)
        fields.next_to(cards, DOWN, buff=0.55)
        rule = self.conclusion(
            "If a privileged field can reach the deployed policy, the experiment is not measuring the claimed task."
        )
        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(card) for card in cards], lag_ratio=0.15),
            run_time=1.5,
        )
        self.reveal(fields, rule)
        self.source("Proposed immutable Taskset contract", label="DATA SCHEMA")
        self.hold(4.8)
        self.wipe()

    def _hugging_face(self) -> None:
        heading = self.heading(
            "Hugging Face imports",
            "Research practice",
            subtitle="A pinned snapshot becomes a reviewed Taskset before training.",
        )
        hub = node("Hugging Face\nrepo + revision", color=BLUE, width=2.3, height=1.1)
        inspect = node(
            "Inspect schema,\nlicense, config",
            color=VIOLET,
            width=2.3,
            height=1.1,
        )
        transform = node("Explicit\ntransform", color=AMBER, width=2.0, height=1.1)
        snapshot = node(
            "Immutable\nTaskset snapshot",
            color=GREEN,
            width=2.35,
            height=1.1,
        )
        run = node("Training run", color=VIOLET, width=1.9, height=1.0)
        flow = VGroup(hub, inspect, transform, snapshot, run)
        flow.arrange(RIGHT, buff=0.4).move_to(UP * 0.55)
        arrows = VGroup(
            *[
                arrow_between(flow[index], flow[index + 1])
                for index in range(len(flow) - 1)
            ]
        )
        manifest = panel(
            "IMPORT MANIFEST",
            [
                "repo · config · split · commit SHA",
                "row count · content hash · license",
                "column mapping · filter log · rejected rows",
            ],
            width=7.0,
            height=2.1,
            color=INK,
            body_size=18,
        )
        manifest.next_to(flow, DOWN, buff=0.55)
        self.reveal(heading, hub)
        for index, arrow in enumerate(arrows):
            self.play(ShowCreation(arrow), FadeIn(flow[index + 1]), run_time=0.65)
        self.reveal(manifest)
        self.source("Recommended lab integration boundary", label="HUGGING FACE")
        self.hold(4.8)
        self.wipe()

    def _baseline_ladder(self) -> None:
        heading = self.heading(
            "Baseline ladder",
            "Research practice",
        )
        base = node("Base model", color=MUTED, width=1.8)
        offline = node(
            "Token imitation /\noffline distillation /\npreference learning",
            color=VIOLET,
            width=2.55,
            height=1.18,
            size=18,
        )
        rl = node("GRPO /\nverifiable rewards", color=GREEN, width=2.15)
        dense = node(
            "OPSD / SDFT /\nSDPO",
            color=AMBER,
            width=2.2,
            height=1.08,
        )
        matched = node("Matched controls", color=INK, width=2.1)
        flow = VGroup(base, offline, rl, dense, matched)
        flow.arrange(RIGHT, buff=0.42).move_to(UP * 0.55)
        arrows = VGroup(
            *[
                arrow_between(flow[index], flow[index + 1])
                for index in range(len(flow) - 1)
            ]
        )
        controls = VGroup(
            pill("same train prompts", MUTED, width=1.85),
            pill("same eval", MUTED, width=1.35),
            pill("same verifier", MUTED, width=1.6),
            pill("same optimizer tokens", MUTED, width=2.15),
            pill("same total compute", MUTED, width=1.9),
        ).arrange(RIGHT, buff=0.22)
        controls.next_to(flow, DOWN, buff=0.7)
        caveat = self.conclusion(
            "Match optimizer tokens and total compute separately; they answer different efficiency questions."
        )
        self.reveal(heading, base)
        for index, arrow in enumerate(arrows):
            self.play(ShowCreation(arrow), FadeIn(flow[index + 1]), run_time=0.58)
        self.reveal(controls, caveat)
        self.source("Proposed ablation ladder", label="EXPERIMENT DESIGN")
        self.hold(4.8)
        self.wipe()

    def _metric_dashboard(self) -> None:
        heading = self.heading(
            "Evaluation dashboard",
            "Research practice",
            subtitle="A single benchmark average can hide regressions and reward exploits.",
        )
        cards = VGroup(
            panel(
                "CAPABILITY",
                ["pass@1", "task reward", "step success"],
                width=2.75,
                height=2.4,
                color=GREEN,
                body_size=18,
            ),
            panel(
                "DIVERSITY",
                ["pass@k", "entropy", "distinct solutions"],
                width=2.75,
                height=2.4,
                color=BLUE,
                body_size=18,
            ),
            panel(
                "RETENTION",
                ["old-domain suite", "reference KL", "regression count"],
                width=2.75,
                height=2.4,
                color=VIOLET,
                body_size=18,
            ),
            panel(
                "INTEGRITY",
                ["exploit rate", "leakage audit", "shadow verifier"],
                width=2.75,
                height=2.4,
                color=CORAL,
                body_size=18,
            ),
        ).arrange(RIGHT, buff=0.28)
        cards.move_to(UP * 0.35)
        spark = bar_chart(
            [
                BarDatum("pass@1", 62, INK),
                BarDatum("pass@8", 81, MUTED),
                BarDatum("retain", 96, INK),
                BarDatum("clean", 99, MUTED),
            ],
            max_value=100,
            width=6.5,
            height=2.1,
            value_suffix="%",
            value_decimals=0,
        )
        spark.next_to(cards, DOWN, buff=0.45)
        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(card) for card in cards], lag_ratio=0.12),
            run_time=1.5,
        )
        self.reveal(spark)
        self.source("Illustrative dashboard values", label="EVALUATION")
        self.hold(4.8)
        self.wipe()

    def _compute_accounting(self) -> None:
        heading = self.heading(
            "Compute accounting",
            "Research practice",
            subtitle="Wall-clock time alone does not reveal why one method costs more.",
        )
        operations = VGroup(
            panel(
                "STUDENT ROLLOUT",
                ["generated tokens", "sampling latency"],
                width=2.65,
                height=2.1,
                color=BLUE,
                body_size=18,
            ),
            panel(
                "TEACHER FORWARD",
                ["scored tokens", "full vs top-k logits"],
                width=2.65,
                height=2.1,
                color=VIOLET,
                body_size=18,
            ),
            panel(
                "BACKWARD PASS",
                ["optimizer tokens", "activation memory"],
                width=2.65,
                height=2.1,
                color=AMBER,
                body_size=18,
            ),
            panel(
                "VERIFIER / TOOLS",
                ["CPU or sandbox time", "external calls"],
                width=2.65,
                height=2.1,
                color=GREEN,
                body_size=18,
            ),
        ).arrange(RIGHT, buff=0.32)
        operations.move_to(UP * 0.4)
        equation = pill(
            "total cost = rollout + teacher + backward + verifier + failed jobs",
            INK,
            width=7.1,
        )
        equation.next_to(operations, DOWN, buff=0.55)
        comparisons = VGroup(
            pill("quality / GPU-hour", MUTED, width=1.9),
            pill("quality / 1M tokens", MUTED, width=2.05),
            pill("peak memory", MUTED, width=1.55),
            pill("time to target", MUTED, width=1.7),
        ).arrange(RIGHT, buff=0.25)
        comparisons.next_to(equation, DOWN, buff=0.35)
        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(card) for card in operations], lag_ratio=0.12),
            run_time=1.5,
        )
        self.reveal(equation, comparisons)
        self.source("Proposed compute vector", label="EFFICIENCY")
        self.hold(4.8)
        self.wipe()

    def _three_campaigns(self) -> None:
        heading = self.heading(
            "One study, two replications",
            "Research practice",
        )
        code = panel(
            "1 · CODE REPAIR",
            [
                "GRPO / OPSD / SDFT / SDPO",
                "public diagnostics + hidden tests",
                "success + recovery + leakage",
            ],
            width=3.65,
            height=3.35,
            color=GREEN,
            body_size=18,
        )
        math = panel(
            "2 · VERIFIED MATH",
            [
                "replicate GRPO / OPSD",
                "exact + shadow symbolic verifier",
                "check whether conclusions transfer",
            ],
            width=3.65,
            height=3.35,
            color=VIOLET,
            body_size=18,
        )
        tools = panel(
            "3 · TOOL PROTOCOL",
            [
                "replicate SDFT / SDPO",
                "state checks + failure diagnostics",
                "acquisition + retention suite",
            ],
            width=3.65,
            height=3.35,
            color=BLUE,
            body_size=18,
        )
        campaigns = VGroup(code, math, tools).arrange(RIGHT, buff=0.42)
        campaigns.move_to(DOWN * 0.05)
        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(card) for card in campaigns], lag_ratio=0.18),
            run_time=1.6,
        )
        question = self.conclusion(
            "Research question: which information channel gives the most useful credit at fixed cost?"
        )
        self.reveal(question)
        self.source("Proposed lab research program", label="USE CASES")
        self.hold(5.0)
        self.wipe()

    def _paper_structure(self) -> None:
        heading = self.heading(
            "Claim-to-evidence map",
            "Research practice",
        )
        sections = VGroup(
            node("1 · Question", width=1.85),
            node("2 · Taskset\ncontract", width=1.95, height=1.05),
            node("3 · Signal\nand objective", width=2.05, height=1.05),
            node("4 · Matched\nbaselines", width=2.0, height=1.05),
            node("5 · Results\n+ failures", width=2.0, height=1.05),
            node("6 · Repro\nartifacts", width=1.85, height=1.05),
        )
        sections.arrange(RIGHT, buff=0.28).move_to(UP * 0.6)
        arrows = VGroup(
            *[
                arrow_between(sections[index], sections[index + 1])
                for index in range(len(sections) - 1)
            ]
        )
        claims = panel(
            "CLAIM TABLE",
            [
                "claim → metric → dataset revision → run IDs",
                "result → confidence interval → ablation",
                "failure → example → proposed mechanism",
            ],
            width=8.1,
            height=2.1,
            color=INK,
            body_size=19,
        )
        claims.next_to(sections, DOWN, buff=0.6)
        self.reveal(heading, sections[0])
        for index, arrow in enumerate(arrows):
            self.play(ShowCreation(arrow), FadeIn(sections[index + 1]), run_time=0.52)
        self.reveal(claims)
        self.source("Recommended research artifact structure", label="PAPER")
        self.hold(4.8)
        self.wipe()

    def _closing_map(self) -> None:
        heading = self.heading(
            "Signal-routing map",
            "Research practice",
            subtitle="Demonstrations, preferences, outcomes, solutions, and feedback create different targets.",
        )
        signals = VGroup(
            panel(
                "DEMONSTRATION",
                ["token imitation", "SDFT"],
                width=2.35,
                height=1.8,
                color=BLUE,
                body_size=19,
            ),
            panel(
                "PREFERENCE",
                ["DPO", "PPO + reward model"],
                width=2.35,
                height=1.8,
                color=VIOLET,
                body_size=17,
            ),
            panel(
                "VERIFIED OUTCOME",
                ["RLVR", "GRPO / DAPO"],
                width=2.35,
                height=1.8,
                color=GREEN,
                body_size=18,
            ),
            panel(
                "PRIVILEGED SOLUTION",
                ["OPSD", "context distillation"],
                width=2.35,
                height=1.8,
                color=AMBER,
                body_size=17,
            ),
            panel(
                "FAILURE EXPLANATION",
                ["SDPO", "SRPO routing"],
                width=2.35,
                height=1.8,
                color=CORAL,
                body_size=18,
            ),
        ).arrange(RIGHT, buff=0.2)
        signals.move_to(UP * 0.55)
        final = text(
            "evidence  →  target  →  update  →  behavior",
            size=40,
            color=AMBER,
            weight="BOLD",
        )
        final.next_to(signals, DOWN, buff=0.9)
        subtitle = text(
            "Trust requires preserved evidence about data, reward, and evaluation.",
            size=21,
            color=MUTED,
        )
        subtitle.next_to(final, DOWN, buff=0.25)
        self.reveal(heading)
        self.play(
            LaggedStart(*[FadeIn(card) for card in signals], lag_ratio=0.12),
            run_time=1.6,
        )
        self.reveal(final, subtitle)
        self.add(self.add_progress())
        self.hold(5.2)
        self.wipe()
