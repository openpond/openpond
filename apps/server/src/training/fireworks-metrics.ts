export type FireworksMetricPoint = {
  step: number;
  maxSteps: number;
  timestamp: string;
  epoch: number | null;
  loss: number | null;
  learningRate: number | null;
  gradientNorm: number | null;
  entropy: number | null;
  meanTokenAccuracy: number | null;
  reward: number | null;
  policyLoss: number | null;
  advantageLoss: number | null;
  inputTokensSeen: number | null;
  memoryBytes: number | null;
  elapsedSeconds: number | null;
};

type MetricPoint = FireworksMetricPoint;

export function normalizeFireworksSftMetrics(
  jsonLines: string,
  fallbackTimestamp: string,
): MetricPoint[] {
  const records = jsonLines
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  const steps = records.flatMap((value) => {
    const record = object(value);
    const data = object(record?.data) ?? record;
    const step = finite(record?.step);
    if (!record || !data || step == null || step < 0) return [];
    return [{
      step: Math.trunc(step),
      timestamp: timestamp(record.timestamp, fallbackTimestamp),
      epoch: metric(data, ["train/epoch", "epoch"]),
      loss: metric(data, ["train/loss", "loss"]),
      learningRate: metric(data, ["train/learning_rate", "train/lr", "learning_rate"]),
      gradientNorm: metric(data, ["train/grad_norm", "gradient_norm"]),
      entropy: metric(data, ["train/entropy", "entropy"]),
      meanTokenAccuracy: metric(data, ["train/mean_token_accuracy", "mean_token_accuracy"]),
      reward: metric(data, ["train/reward", "reward", "score"]),
      policyLoss: metric(data, ["train/policy_loss", "policy_loss"]),
      advantageLoss: metric(data, ["train/adv_loss", "adv_loss", "advantage_loss"]),
      inputTokensSeen: integerMetric(
        data,
        ["train/token", "train/tokens", "train/total_tokens", "tokens"],
      ),
      memoryBytes: integerMetric(data, ["train/memory_bytes", "memory_bytes"]),
      elapsedSeconds: metric(data, ["train/elapsed_seconds", "elapsed_seconds"]),
    }];
  });
  const maxSteps = Math.max(1, ...steps.map((point) => point.step));
  return steps.map((point) => ({ ...point, maxSteps }));
}

export function normalizeFireworksRftMetrics(input: {
  metrics: unknown;
  stats?: unknown;
  fallbackTimestamp: string;
}): MetricPoint[] {
  const metrics = parseUnknownJson(input.metrics);
  const stats = parseUnknownJson(input.stats);
  const curves = object(object(metrics)?.curves);
  const averages = object(curves?.average);
  const series = new Map<number, Partial<MetricPoint>>();
  if (averages) {
    for (const [name, values] of Object.entries(averages)) {
      if (!Array.isArray(values)) continue;
      values.forEach((value, index) => {
        const number = finite(value);
        if (number == null) return;
        const step = index + 1;
        const point = series.get(step) ?? {};
        assignRftSeries(point, name, number);
        series.set(step, point);
      });
    }
  }
  const epochOutputs = object(object(metrics)?.epoch_to_evaluation_output);
  if (epochOutputs) {
    for (const [epochKey, output] of Object.entries(epochOutputs)) {
      const epoch = finite(epochKey);
      const outputMetrics = object(object(output)?.metrics);
      const rollup = object(outputMetrics?.rollup_distribution);
      const reward = finite(rollup?.average);
      if (reward == null) continue;
      const step = Math.max(1, Math.trunc((epoch ?? series.size) + 1));
      const point = series.get(step) ?? {};
      point.epoch = epoch;
      point.reward = reward;
      series.set(step, point);
    }
  }
  const summary = object(stats);
  if (summary && finite(summary.steps) != null) {
    const step = Math.max(1, Math.trunc(finite(summary.steps)!));
    const point = series.get(step) ?? {};
    point.loss = finite(summary.loss_ema);
    point.policyLoss = finite(summary.loss_ema);
    point.advantageLoss = finite(summary.adv_loss_ema);
    point.inputTokensSeen = nonnegativeInteger(summary.tokens);
    point.epoch = finite(summary.epochs);
    series.set(step, point);
  }
  const maxSteps = Math.max(1, ...series.keys());
  return [...series.entries()]
    .sort(([left], [right]) => left - right)
    .map(([step, point]) => ({
      step,
      maxSteps,
      timestamp: input.fallbackTimestamp,
      epoch: point.epoch ?? null,
      loss: point.loss ?? null,
      learningRate: point.learningRate ?? null,
      gradientNorm: point.gradientNorm ?? null,
      entropy: point.entropy ?? null,
      meanTokenAccuracy: point.meanTokenAccuracy ?? null,
      reward: point.reward ?? null,
      policyLoss: point.policyLoss ?? null,
      advantageLoss: point.advantageLoss ?? null,
      inputTokensSeen: point.inputTokensSeen ?? null,
      memoryBytes: point.memoryBytes ?? null,
      elapsedSeconds: point.elapsedSeconds ?? null,
    }));
}

function assignRftSeries(
  point: Partial<MetricPoint>,
  rawName: string,
  value: number,
): void {
  const name = rawName.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");
  if (name.includes("reward") || name === "score") point.reward = value;
  else if (name.includes("adv") && name.includes("loss")) point.advantageLoss = value;
  else if (name.includes("policy") && name.includes("loss")) point.policyLoss = value;
  else if (name.includes("loss")) point.loss = value;
  else if (name.includes("learning") || name === "lr") point.learningRate = value;
  else if (name.includes("entropy")) point.entropy = value;
}

function parseUnknownJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function metric(
  record: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = finite(record[key]);
    if (value != null) return value;
  }
  return null;
}

function integerMetric(
  record: Record<string, unknown>,
  keys: string[],
): number | null {
  const value = metric(record, keys);
  return value == null ? null : Math.max(0, Math.trunc(value));
}

function nonnegativeInteger(value: unknown): number | null {
  const number = finite(value);
  return number == null ? null : Math.max(0, Math.trunc(number));
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function timestamp(value: unknown, fallback: string): string {
  const seconds = finite(value);
  if (seconds != null) return new Date(seconds * 1_000).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallback;
}
