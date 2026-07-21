import { describe, expect, test, vi } from "vitest";
import {
  huggingFaceResolveUrl,
  inspectHuggingFaceDataset,
  normalizeHuggingFaceDatasetLocator,
  suggestedHuggingFaceMapping,
} from "./hugging-face.js";

const SOURCE_REVISION = "a".repeat(40);
const PARQUET_REVISION = "b".repeat(40);

describe("Hugging Face Dataset adapter", () => {
  test("normalizes repository IDs and pinned Dataset URLs only", () => {
    expect(
      normalizeHuggingFaceDatasetLocator("org/dataset"),
    ).toMatchObject({
      repositoryId: "org/dataset",
      repositoryUrl: "https://huggingface.co/datasets/org/dataset",
      requestedRevision: null,
    });
    expect(
      normalizeHuggingFaceDatasetLocator(
        "https://huggingface.co/datasets/org/dataset/tree/release%2F1",
      ),
    ).toMatchObject({
      repositoryId: "org/dataset",
      requestedRevision: "release/1",
    });
    expect(() =>
      normalizeHuggingFaceDatasetLocator(
        "https://example.com/datasets/org/dataset",
      ),
    ).toThrow("Only credential-free");
    expect(() =>
      normalizeHuggingFaceDatasetLocator(
        "https://token@huggingface.co/datasets/org/dataset",
      ),
    ).toThrow("Only credential-free");
  });

  test("pins source and conversion revisions and suggests semantic mapping", async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://huggingface.co/api/datasets/org/dataset") {
        return json({
          sha: SOURCE_REVISION,
          private: false,
          gated: false,
          cardData: {
            pretty_name: "Math Dataset",
            description: "A fixture.",
            license: "apache-2.0",
          },
          tags: ["license:apache-2.0"],
        });
      }
      if (url.includes("/splits?")) {
        return json({
          splits: [
            { dataset: "org/dataset", config: "default", split: "train" },
            { dataset: "org/dataset", config: "default", split: "test" },
          ],
        });
      }
      if (url.includes("/first-rows?")) {
        return json({
          features: [],
          rows: [
            {
              row: {
                id: "row-1",
                prompt: [{ role: "user", content: "1 + 1?" }],
                answer: "2",
              },
            },
          ],
        });
      }
      if (url.includes("/size?")) {
        return json({
          size: {
            splits: [
              {
                config: "default",
                split: "train",
                num_rows: 10,
                num_bytes_parquet_files: 100,
              },
              {
                config: "default",
                split: "test",
                num_rows: 2,
                num_bytes_parquet_files: 20,
              },
            ],
          },
        });
      }
      if (url.includes("/parquet?")) {
        return json({
          partial: false,
          pending: [],
          failed: [],
          parquet_files: [
            {
              dataset: "org/dataset",
              config: "default",
              split: "train",
              filename: "0000.parquet",
              size: 100,
            },
            {
              dataset: "org/dataset",
              config: "default",
              split: "test",
              filename: "0000.parquet",
              size: 20,
            },
          ],
        });
      }
      if (url.includes("/revision/refs%2Fconvert%2Fparquet")) {
        return json({ sha: PARQUET_REVISION });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const inspection = await inspectHuggingFaceDataset(
      normalizeHuggingFaceDatasetLocator("org/dataset"),
      request as typeof fetch,
    );

    expect(inspection).toMatchObject({
      resolvedRevision: SOURCE_REVISION,
      title: "Math Dataset",
      declaredLicense: "apache-2.0",
      configurations: ["default"],
      splits: [
        { configuration: "default", split: "train", rowCount: 10 },
        { configuration: "default", split: "test", rowCount: 2 },
      ],
      metadata: { parquetRevision: PARQUET_REVISION },
    });
    expect(inspection.sourceFiles).toEqual([
      expect.objectContaining({
        path: "default/train/0000.parquet",
        split: "train",
        revision: PARQUET_REVISION,
        sizeBytes: 100,
      }),
      expect.objectContaining({
        path: "default/test/0000.parquet",
        split: "test",
        revision: PARQUET_REVISION,
        sizeBytes: 20,
      }),
    ]);
    expect(suggestedHuggingFaceMapping(inspection)).toMatchObject({
      preset: "prompt_expected_answer",
      configuration: "default",
      upstreamSplits: ["train", "test"],
      splitPolicy: {
        assignments: { train: "train", test: "frozen_eval" },
      },
      bindings: [
        expect.objectContaining({ sourcePath: "id", target: "row_id" }),
        expect.objectContaining({ sourcePath: "prompt", target: "messages" }),
        expect.objectContaining({
          sourcePath: "answer",
          target: "expected_output",
        }),
      ],
    });
    expect(
      huggingFaceResolveUrl(
        "org/dataset",
        PARQUET_REVISION,
        "default/train/0000.parquet",
      ),
    ).toBe(
      `https://huggingface.co/datasets/org/dataset/resolve/${PARQUET_REVISION}/default/train/0000.parquet`,
    );
  });

  test("rejects metadata that exceeds the inspection byte limit", async () => {
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    const request = vi.fn(async () =>
      new Response(oversized as unknown as BodyInit));

    await expect(inspectHuggingFaceDataset(
      normalizeHuggingFaceDatasetLocator("org/dataset"),
      request as typeof fetch,
    )).rejects.toThrow("metadata exceeded its byte limit");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function json(value: unknown): Response {
  return Response.json(value, {
    headers: { "content-length": String(JSON.stringify(value).length) },
  });
}
