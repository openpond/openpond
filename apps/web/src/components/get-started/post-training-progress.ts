import { useSyncExternalStore } from "react";

export const POST_TRAINING_PROGRESS_STORAGE_KEY = "openpond.post-training-progress.v1";

export type PostTrainingLessonProgress = {
  completed: boolean;
  currentTime: number;
  duration: number;
  updatedAt: number;
};

export type PostTrainingProgress = Readonly<Record<string, PostTrainingLessonProgress>>;

type LessonProgressUpdate = {
  completed?: boolean;
  currentTime: number;
  duration: number;
  lessonId: string;
};

const EMPTY_PROGRESS: PostTrainingProgress = Object.freeze({});
const STORAGE_WRITE_INTERVAL_MS = 1_000;
const listeners = new Set<() => void>();

let progressSnapshot: PostTrainingProgress | null = null;
let persistTimer: number | null = null;
let storageListenersAttached = false;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizePostTrainingProgress(value: unknown): PostTrainingProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_PROGRESS;

  const normalized: Record<string, PostTrainingLessonProgress> = {};
  for (const [lessonId, candidate] of Object.entries(value)) {
    if (!lessonId || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const duration = finiteNumber(record.duration);
    const currentTime = finiteNumber(record.currentTime);
    const updatedAt = finiteNumber(record.updatedAt);
    if (duration === null || duration <= 0 || currentTime === null) continue;

    const completed = record.completed === true;
    normalized[lessonId] = {
      completed,
      currentTime: completed
        ? duration
        : Math.min(duration, Math.max(0, currentTime)),
      duration,
      updatedAt: updatedAt === null ? 0 : Math.max(0, updatedAt),
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : EMPTY_PROGRESS;
}

export function parsePostTrainingProgress(serialized: string | null): PostTrainingProgress {
  if (!serialized) return EMPTY_PROGRESS;
  try {
    return normalizePostTrainingProgress(JSON.parse(serialized));
  } catch {
    return EMPTY_PROGRESS;
  }
}

function loadProgress(): PostTrainingProgress {
  if (typeof window === "undefined") return EMPTY_PROGRESS;
  try {
    return parsePostTrainingProgress(window.localStorage.getItem(POST_TRAINING_PROGRESS_STORAGE_KEY));
  } catch {
    return EMPTY_PROGRESS;
  }
}

function persistProgress() {
  if (typeof window !== "undefined" && persistTimer !== null) {
    window.clearTimeout(persistTimer);
  }
  persistTimer = null;
  if (typeof window === "undefined" || progressSnapshot === null) return;
  try {
    window.localStorage.setItem(
      POST_TRAINING_PROGRESS_STORAGE_KEY,
      JSON.stringify(progressSnapshot),
    );
  } catch {
    // Playback should continue when storage is unavailable or full.
  }
}

function schedulePersistence() {
  if (typeof window === "undefined" || persistTimer !== null) return;
  persistTimer = window.setTimeout(persistProgress, STORAGE_WRITE_INTERVAL_MS);
}

function attachStorageListeners() {
  if (typeof window === "undefined" || storageListenersAttached) return;
  storageListenersAttached = true;
  window.addEventListener("pagehide", persistProgress);
  window.addEventListener("storage", (event) => {
    if (event.key !== POST_TRAINING_PROGRESS_STORAGE_KEY) return;
    progressSnapshot = parsePostTrainingProgress(event.newValue);
    listeners.forEach((listener) => listener());
  });
}

export function getPostTrainingProgress(): PostTrainingProgress {
  if (progressSnapshot === null) progressSnapshot = loadProgress();
  attachStorageListeners();
  return progressSnapshot;
}

export function recordPostTrainingLessonProgress({
  completed = false,
  currentTime,
  duration,
  lessonId,
}: LessonProgressUpdate) {
  if (!lessonId || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) {
    return;
  }

  const current = getPostTrainingProgress();
  const previous = current[lessonId];
  const nextCompleted = Boolean(previous?.completed || completed);
  const nextCurrentTime = nextCompleted
    ? duration
    : Math.min(duration, Math.max(0, currentTime));
  if (
    previous
    && previous.completed === nextCompleted
    && Math.abs(previous.currentTime - nextCurrentTime) < 0.25
    && Math.abs(previous.duration - duration) < 0.25
  ) {
    return;
  }

  progressSnapshot = {
    ...current,
    [lessonId]: {
      completed: nextCompleted,
      currentTime: nextCurrentTime,
      duration,
      updatedAt: Date.now(),
    },
  };
  schedulePersistence();
  listeners.forEach((listener) => listener());
}

export function postTrainingProgressPercent(
  progress: PostTrainingLessonProgress | undefined,
): number {
  if (!progress) return 0;
  if (progress.completed) return 100;
  if (progress.duration <= 0) return 0;
  return Math.min(99, Math.max(0, Math.round(
    (progress.currentTime / progress.duration) * 100,
  )));
}

export function postTrainingResumeTime(
  progress: PostTrainingLessonProgress | undefined,
): number {
  if (!progress || progress.completed || progress.currentTime < 1) return 0;
  return progress.currentTime < progress.duration - 2 ? progress.currentTime : 0;
}

export function startingPostTrainingLessonIndex(
  progress: PostTrainingProgress,
  lessonIds: readonly string[],
): number {
  let latestInProgressIndex = -1;
  let latestUpdatedAt = -1;
  lessonIds.forEach((lessonId, index) => {
    const lessonProgress = progress[lessonId];
    if (
      lessonProgress
      && !lessonProgress.completed
      && lessonProgress.currentTime > 0
      && lessonProgress.updatedAt > latestUpdatedAt
    ) {
      latestInProgressIndex = index;
      latestUpdatedAt = lessonProgress.updatedAt;
    }
  });
  if (latestInProgressIndex >= 0) return latestInProgressIndex;

  const firstIncompleteIndex = lessonIds.findIndex((lessonId) => !progress[lessonId]?.completed);
  return firstIncompleteIndex >= 0 ? firstIncompleteIndex : 0;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePostTrainingProgress(): PostTrainingProgress {
  return useSyncExternalStore(subscribe, getPostTrainingProgress, () => EMPTY_PROGRESS);
}
