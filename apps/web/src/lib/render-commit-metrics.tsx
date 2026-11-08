import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

export type RenderCommitMetric = {
  commits: number;
  maxActualDurationMs: number;
  totalActualDurationMs: number;
};

type RenderCommitTrace = {
  id: string;
  phase: string;
  startTime: number;
  commitTime: number;
};

type RenderCommitMetricsApi = {
  getTrace(): RenderCommitTrace[];
  get(): Record<string, RenderCommitMetric>;
  reset(): void;
};

declare global {
  interface Window {
    __OPENPOND_RENDER_COMMITS__?: RenderCommitMetricsApi;
  }
}

const metrics = new Map<string, RenderCommitMetric>();
const trace: RenderCommitTrace[] = [];

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, _baseDuration, startTime, commitTime) => {
  trace.push({ id, phase, startTime, commitTime });
  if (trace.length > 256) trace.shift();
  const current = metrics.get(id) ?? {
    commits: 0,
    maxActualDurationMs: 0,
    totalActualDurationMs: 0,
  };
  current.commits += 1;
  current.maxActualDurationMs = Math.max(current.maxActualDurationMs, actualDuration);
  current.totalActualDurationMs += actualDuration;
  metrics.set(id, current);
};

export function RenderCommitBoundary({ children, id }: { children: ReactNode; id: string }) {
  return <Profiler id={id} onRender={onRender}>{children}</Profiler>;
}

if (typeof window !== "undefined") {
  window.__OPENPOND_RENDER_COMMITS__ = {
    get: () => Object.fromEntries(
      [...metrics.entries()].map(([id, metric]) => [id, { ...metric }]),
    ),
    getTrace: () => trace.map((entry) => ({ ...entry })),
    reset: () => { metrics.clear(); trace.length = 0; },
  };
}
