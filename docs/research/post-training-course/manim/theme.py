"""Mathematical-animation visual language for the post-training course."""

from manimlib import *
from manimlib.utils.color import color_to_rgba


BACKGROUND = "#0E1014"
SURFACE = "#12151A"
SURFACE_2 = "#171B21"
INK = "#F2F2F2"
MUTED = "#A3A7AE"
GRID = "#343941"

# Color is reserved for mathematical meaning: distributions, signals, rewards,
# teacher context, and failure. Structural surfaces stay in muted blacks.
CYAN = "#58C4DD"
BLUE = "#4EA7E0"
VIOLET = "#9A72AC"
GREEN = "#83C167"
AMBER = "#F0C75E"
CORAL = "#FC6255"
PINK = "#D147BD"

SUCCESS = GREEN
FAILURE = CORAL
STUDENT = CYAN
TEACHER = VIOLET
REWARD = AMBER

FONT = "DejaVu Sans"
MONO_FONT = "DejaVu Sans Mono"

TITLE_SIZE = 54
SUBTITLE_SIZE = 28
BODY_SIZE = 25
SMALL_SIZE = 20
FOOTER_SIZE = 16

FRAME_W = 14.22
FRAME_H = 8.0


def apply_course_background(scene: Scene) -> None:
    # ManimGL stores the active clear color in background_rgba. Assigning a
    # background_color attribute after camera construction does not change it.
    scene.camera.background_rgba = list(color_to_rgba(BACKGROUND))
