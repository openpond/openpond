export type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type MacdResult = {
  macd: number;
  signalLine: number;
  histogram: number;
};

export type MaCrossSignal =
  | "neutral"
  | "bullish"
  | "bearish"
  | "bullish-cross"
  | "bearish-cross";

export type MaCrossResult = {
  fast: number;
  slow: number;
  signal: MaCrossSignal;
};

export type BollingerResult = {
  middle: number;
  upper: number;
  lower: number;
};

export type PriceChangeResult = {
  previous: number;
  percent: number;
};

export function computeRsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) {
      gains += delta;
    } else {
      losses -= delta;
    }
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function computeSmaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const series: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) {
      sum -= values[i - period];
    }
    if (i >= period - 1) {
      series.push(sum / period);
    }
  }
  return series;
}

export function computeSma(values: number[], period: number): number | null {
  const series = computeSmaSeries(values, period);
  return series.length > 0 ? series[series.length - 1] : null;
}

export function computeEmaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const start = values.slice(0, period);
  let ema = start.reduce((sum, value) => sum + value, 0) / period;
  const series = [ema];
  for (let i = period; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k);
    series.push(ema);
  }
  return series;
}

export function computeEma(values: number[], period: number): number | null {
  const series = computeEmaSeries(values, period);
  return series.length > 0 ? series[series.length - 1] : null;
}

export function computeMacd(values: number[]): MacdResult | null {
  const emaFast = computeEmaSeries(values, 12);
  const emaSlow = computeEmaSeries(values, 26);
  if (emaFast.length === 0 || emaSlow.length === 0) return null;
  const offset = emaFast.length - emaSlow.length;
  const macdSeries = emaSlow.map((value, idx) => emaFast[idx + offset] - value);
  const signalSeries = computeEmaSeries(macdSeries, 9);
  if (signalSeries.length === 0) return null;
  const macd = macdSeries[macdSeries.length - 1];
  const signalLine = signalSeries[signalSeries.length - 1];
  return {
    macd,
    signalLine,
    histogram: macd - signalLine,
  };
}

export function computeMaCross(
  values: number[],
  type: "sma" | "ema",
  fastPeriod: number,
  slowPeriod: number
): MaCrossResult | null {
  if (values.length < slowPeriod) return null;
  const fastSeries =
    type === "ema"
      ? computeEmaSeries(values, fastPeriod)
      : computeSmaSeries(values, fastPeriod);
  const slowSeries =
    type === "ema"
      ? computeEmaSeries(values, slowPeriod)
      : computeSmaSeries(values, slowPeriod);
  if (fastSeries.length === 0 || slowSeries.length === 0) return null;
  const offset = fastSeries.length - slowSeries.length;
  if (offset < 0) return null;
  const lastIndex = slowSeries.length - 1;
  const fastNow = fastSeries[lastIndex + offset];
  const slowNow = slowSeries[lastIndex];
  const prevIndex = lastIndex - 1;
  const fastPrev = prevIndex >= 0 ? fastSeries[prevIndex + offset] : null;
  const slowPrev = prevIndex >= 0 ? slowSeries[prevIndex] : null;

  let signal: MaCrossSignal = "neutral";
  if (fastPrev != null && slowPrev != null) {
    if (fastPrev <= slowPrev && fastNow > slowNow) {
      signal = "bullish-cross";
    } else if (fastPrev >= slowPrev && fastNow < slowNow) {
      signal = "bearish-cross";
    } else if (fastNow > slowNow) {
      signal = "bullish";
    } else if (fastNow < slowNow) {
      signal = "bearish";
    }
  } else if (fastNow > slowNow) {
    signal = "bullish";
  } else if (fastNow < slowNow) {
    signal = "bearish";
  }

  return { fast: fastNow, slow: slowNow, signal };
}

export function computeBollinger(
  values: number[],
  period = 20,
  multiplier = 2
): BollingerResult | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((sum, value) => sum + value, 0) / period;
  const variance =
    slice.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    middle: mean,
    upper: mean + multiplier * stdDev,
    lower: mean - multiplier * stdDev,
  };
}

export function computePriceChange(
  values: number[],
  lookback = 24
): PriceChangeResult | null {
  if (values.length < 2) return null;
  const current = values[values.length - 1];
  const index = Math.max(0, values.length - 1 - lookback);
  const previous = values[index];
  if (previous === 0) return null;
  const percent = ((current - previous) / previous) * 100;
  return {
    previous,
    percent,
  };
}

export function computeAtr(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const ranges: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const current = bars[i];
    const prev = bars[i - 1];
    const rangeHighLow = current.high - current.low;
    const rangeHighClose = Math.abs(current.high - prev.close);
    const rangeLowClose = Math.abs(current.low - prev.close);
    ranges.push(Math.max(rangeHighLow, rangeHighClose, rangeLowClose));
  }
  if (ranges.length < period) return null;
  const slice = ranges.slice(-period);
  const sum = slice.reduce((total, value) => total + value, 0);
  return sum / period;
}
