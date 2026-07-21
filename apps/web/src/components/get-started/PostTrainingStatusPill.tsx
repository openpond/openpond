import { POST_TRAINING_SERIES_STATUS } from "./post-training-lessons";

const STATUS_TOOLTIP = "Subject to change, lesson work in progress";

export function PostTrainingStatusPill() {
  const label = POST_TRAINING_SERIES_STATUS === "draft" ? "Draft" : "Published";
  return (
    <span
      aria-label={`${label}: ${STATUS_TOOLTIP}`}
      className="get-started-playlist-status app-tooltip"
      data-tooltip={STATUS_TOOLTIP}
      tabIndex={0}
    >
      {label}
    </span>
  );
}
