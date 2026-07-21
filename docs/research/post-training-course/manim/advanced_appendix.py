"""Optional advanced scenes removed from the core conceptual course."""

from chapter05_grpo import Chapter05GRPO
from chapter06_distillation import Chapter06Distillation
from chapter07_methods import Chapter07Methods


class Appendix01GRPODetails(Chapter05GRPO):
    chapter_number = 1
    chapter_count = 3

    def construct(self) -> None:
        self.lesson_intro(
            "Technical appendix",
            "Implementation details and paper results behind the core lessons.",
        )
        self.part_card(
            "APPENDIX I",
            "GRPO DETAILS",
            "Normalization, response length, and diversity metrics.",
        )
        self._length_bias()
        self._diversity_metrics()


class Appendix02DistillationSystems(Chapter06Distillation):
    chapter_number = 2
    chapter_count = 3

    def construct(self) -> None:
        self.part_card(
            "APPENDIX II",
            "DISTILLATION SYSTEMS",
            "Teacher-logit storage and the fidelity cost of compression.",
        )
        self._top_k_storage()


class Appendix03MethodStudies(Chapter07Methods):
    chapter_number = 3
    chapter_count = 3

    def construct(self) -> None:
        self.part_card(
            "APPENDIX III",
            "PAPER DETAILS",
            "Reported scaling results and sample-routed policy optimization.",
        )
        self._opsd_scaling_results()
        self._reported_results()
        self.concept_card(
            "SRPO",
            "Sample-Routed Policy Optimization",
            "Successful and failed rollouts are sent to different learning signals.",
            "The router chooses the evidence path; it is not one uniform loss.",
        )
        self._routing()
