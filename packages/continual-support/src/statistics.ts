export type PairedObservation = {
  id: string;
  candidate: number;
  reference: number;
};

export type PairedEstimate = {
  count: number;
  candidateMean: number;
  referenceMean: number;
  meanDifference: number;
  confidenceInterval: [number, number];
  candidateWins: number;
  ties: number;
  referenceWins: number;
  twoSidedSignTestPValue: number;
};

export function pairedBootstrapEstimate(input: {
  observations: PairedObservation[];
  samples?: number;
  confidenceLevel?: number;
  seed?: number;
}): PairedEstimate {
  const ordered = [...input.observations].sort((left, right) => left.id.localeCompare(right.id));
  if (!ordered.length) throw new Error("Paired statistics require at least one observation.");
  if (new Set(ordered.map((item) => item.id)).size !== ordered.length) throw new Error("Paired observation ids must be unique.");
  if (ordered.some((item) => !Number.isFinite(item.candidate) || !Number.isFinite(item.reference))) throw new Error("Paired values must be finite.");
  const samples = input.samples ?? 10_000;
  if (!Number.isInteger(samples) || samples < 1_000) throw new Error("Bootstrap samples must be an integer of at least 1,000.");
  const confidence = input.confidenceLevel ?? 0.95;
  if (!(confidence > 0 && confidence < 1)) throw new Error("confidenceLevel must be in (0, 1).");
  const random = xorshift32(input.seed ?? 0x6f70656e);
  const differences = ordered.map((item) => item.candidate - item.reference);
  const bootstrap = new Array<number>(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < differences.length; index += 1) {
      sum += differences[Math.floor(random() * differences.length)]!;
    }
    bootstrap[sample] = sum / differences.length;
  }
  bootstrap.sort((left, right) => left - right);
  const alpha = (1 - confidence) / 2;
  const wins = differences.filter((difference) => difference > 0).length;
  const losses = differences.filter((difference) => difference < 0).length;
  return {
    count: ordered.length,
    candidateMean: mean(ordered.map((item) => item.candidate)),
    referenceMean: mean(ordered.map((item) => item.reference)),
    meanDifference: mean(differences),
    confidenceInterval: [quantile(bootstrap, alpha), quantile(bootstrap, 1 - alpha)],
    candidateWins: wins,
    ties: differences.length - wins - losses,
    referenceWins: losses,
    twoSidedSignTestPValue: twoSidedSignTest(wins, losses),
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(sorted: number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function twoSidedSignTest(wins: number, losses: number): number {
  const trials = wins + losses;
  if (!trials) return 1;
  const extreme = Math.min(wins, losses);
  let cumulative = 0;
  for (let successes = 0; successes <= extreme; successes += 1) cumulative += binomialProbability(trials, successes);
  return Math.min(1, cumulative * 2);
}

function binomialProbability(trials: number, successes: number): number {
  let coefficient = 1;
  for (let index = 1; index <= successes; index += 1) coefficient *= (trials - successes + index) / index;
  return coefficient * 0.5 ** trials;
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
