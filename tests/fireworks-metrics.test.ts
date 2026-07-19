import { describe, expect, test } from "vitest";
import {
  normalizeFireworksRftMetrics,
  normalizeFireworksSftMetrics,
} from "../apps/server/src/training/fireworks-metrics";

describe("Fireworks training metric normalization", () => {
  test("reads provider SFT JSONL without dropping step loss", () => {
    const points = normalizeFireworksSftMetrics(
      [
        JSON.stringify({
          timestamp: 1_784_318_345.9332526,
          step: 1,
          data: {
            "train/epoch": 0,
            "train/seq": 5,
            "train/token": 20_248,
            "train/loss": 0.931962,
          },
        }),
        "not json",
      ].join("\n"),
      "2026-07-17T00:00:00.000Z",
    );

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      step: 1,
      maxSteps: 1,
      epoch: 0,
      loss: 0.931962,
      inputTokensSeen: 20_248,
    });
    expect(points[0]?.timestamp).toBe("2026-07-17T19:59:05.933Z");
  });

  test("reads the current flattened provider SFT JSONL shape", () => {
    const points = normalizeFireworksSftMetrics(
      [
        JSON.stringify({
          step: 1,
          "train/step": 1,
          "train/loss": 1.3793992257766468,
          "train/lr": 0.0001,
          "train/total_tokens": 106_622,
        }),
        JSON.stringify({
          step: 2,
          "train/step": 2,
          "train/loss": 1.1347249713043017,
          "train/lr": 0.0001,
          "train/total_tokens": 61_186,
        }),
      ].join("\n"),
      "2026-07-18T06:38:26.244Z",
    );

    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({
      step: 1,
      maxSteps: 2,
      loss: 1.3793992257766468,
      learningRate: 0.0001,
      inputTokensSeen: 106_622,
    });
    expect(points[1]).toMatchObject({
      step: 2,
      maxSteps: 2,
      loss: 1.1347249713043017,
      inputTokensSeen: 61_186,
    });
  });

  test("combines RFT reward curves with negative policy and advantage losses", () => {
    const points = normalizeFireworksRftMetrics({
      metrics: {
        curves: {
          average: {
            Score: [0.10462961111111112],
          },
        },
        epoch_to_evaluation_output: {
          "0": {
            metrics: {
              rollup_distribution: {
                average: 0.10462961111111112,
              },
            },
          },
        },
      },
      stats: {
        steps: 3,
        tokens: 11_880,
        loss_ema: -0.0240457,
        adv_loss_ema: 0.01888896,
      },
      fallbackTimestamp: "2026-07-17T00:00:00.000Z",
    });

    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({
      step: 1,
      reward: 0.10462961111111112,
    });
    expect(points[1]).toMatchObject({
      step: 3,
      maxSteps: 3,
      loss: -0.0240457,
      policyLoss: -0.0240457,
      advantageLoss: 0.01888896,
      inputTokensSeen: 11_880,
    });
  });
});
