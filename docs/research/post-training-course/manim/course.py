"""ManimGL entry point for the first-principles post-training course.

Run a scene from this directory, for example:
    manimgl course.py Chapter05GRPO -w -m
"""

from pathlib import Path
import sys

from manimlib import *

COURSE_DIR = Path(__file__).resolve().parent
if str(COURSE_DIR) not in sys.path:
    sys.path.insert(0, str(COURSE_DIR))

from chapter01_policy import Chapter01Policy as _Chapter01Policy
from chapter02_definitions import Chapter02Definitions as _Chapter02Definitions
from chapter02_on_off_policy import Chapter02OnOffPolicy as _Chapter02OnOffPolicy
from chapter03_rl_signals import Chapter03RLSignals as _Chapter03RLSignals
from chapter04_rlvr import Chapter04RLVR as _Chapter04RLVR
from chapter05_grpo import Chapter05GRPO as _Chapter05GRPO
from chapter06_distillation import Chapter06Distillation as _Chapter06Distillation
from chapter07_methods import Chapter07Methods as _Chapter07Methods
from chapter08_research import Chapter08Research as _Chapter08Research
from advanced_appendix import (
    Appendix01GRPODetails as _Appendix01GRPODetails,
    Appendix02DistillationSystems as _Appendix02DistillationSystems,
    Appendix03MethodStudies as _Appendix03MethodStudies,
)


# ManimGL discovers scenes defined in this module. Thin subclasses keep the
# implementation split into focused chapter files while exposing one entrypoint.
class Chapter01Policy(_Chapter01Policy):
    pass


class Chapter02Definitions(_Chapter02Definitions):
    pass


class Chapter02OnOffPolicy(_Chapter02OnOffPolicy):
    pass


class Chapter03RLSignals(_Chapter03RLSignals):
    pass


class Chapter04RLVR(_Chapter04RLVR):
    pass


class Chapter05GRPO(_Chapter05GRPO):
    pass


class Chapter06Distillation(_Chapter06Distillation):
    pass


class Chapter07Methods(_Chapter07Methods):
    pass


class Chapter08Research(_Chapter08Research):
    pass


class Appendix01GRPODetails(_Appendix01GRPODetails):
    pass


class Appendix02DistillationSystems(_Appendix02DistillationSystems):
    pass


class Appendix03MethodStudies(_Appendix03MethodStudies):
    pass


__all__ = [
    "Chapter01Policy",
    "Chapter02Definitions",
    "Chapter02OnOffPolicy",
    "Chapter03RLSignals",
    "Chapter04RLVR",
    "Chapter05GRPO",
    "Chapter06Distillation",
    "Chapter07Methods",
    "Chapter08Research",
    "Appendix01GRPODetails",
    "Appendix02DistillationSystems",
    "Appendix03MethodStudies",
]
