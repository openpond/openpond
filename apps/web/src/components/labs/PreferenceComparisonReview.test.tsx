import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { useTraining } from "../../hooks/useTraining";
import { PreferenceComparisonReview } from "./PreferenceComparisonReview";

describe("PreferenceComparisonReview", () => {
  it("renders the same generalized calibration controls for text or image tasksets", () => {
    const training = {
      busyAction: null,
      actions: {
        nextPreferenceComparison: async () => null,
        preferenceArtifactUrl: async () => null,
        submitPreferenceComparison: async () => null,
        markPreferenceComparisonUnreviewable: async () => null,
        preferenceCalibrationStatus: async () => null,
        runNextPreferenceCalibrationReview: async () => null,
        startPreferenceCalibrationBatch: async () => null,
        syncPreferenceCalibrationBatch: async () => null,
        savePreferenceCalibration: async () => null,
      },
    } as unknown as ReturnType<typeof useTraining>;

    const html = renderToStaticMarkup(
      <PreferenceComparisonReview
        tasksetId="taskset-1"
        reviewerKey="local-reviewer"
        defaultModel={{ providerId: "openai", modelId: "gpt-5.4" }}
        defaultMinimumSamples={100}
        defaultRubric="Prefer coherent, polished outputs."
        training={training}
      />,
    );

    expect(html).toContain("Generate 1 comparison (4 candidates)");
    expect(html).toContain("One managed batch creates one four-candidate human assignment.");
    expect(html).toContain("Sync candidate batch");
    expect(html).toContain("Run next model review");
    expect(html).toContain("Save calibration report");
    expect(html).toContain("Open next review");
    expect(html).toContain("My review queue");
    expect(html).toContain("Prefer coherent, polished outputs.");
  });
});
