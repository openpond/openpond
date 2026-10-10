import { describe, expect, test, vi } from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {SqliteStore} from "../../store/store.js";
import {createDatasetImportService} from "./import-service.js";
import {createChatDatasetSourceAction} from "../chat-dataset-sources.js";
import {createLocalDatasetService} from "../local-dataset-service.js";
import type {LocalDatasetRecord} from "@openpond/contracts";
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
    let previewAnswer="2",declaredLicense="apache-2.0";
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
            license: declaredLicense,
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
                answer: previewAnswer,
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
      request as unknown as typeof fetch,
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
    // Selected source bytes must survive upstream changes without claiming
    // full-source qualification or leaking non-selected/private source rows.
    const home=await mkdtemp(path.join(os.tmpdir(),"openpond-hf-chat-")),store=new SqliteStore(home);
    try{
      const imports=createDatasetImportService({store,workerProjectDir:home,datasetStorageRoot:async()=>null,request:request as unknown as typeof fetch});
      const datasets=createLocalDatasetService({store,home,sourceAction:createChatDatasetSourceAction({store,imports,create:input=>datasets.request(input)})});
      const job=await datasets.request({action:"inspect_source",payload:{url:"org/dataset",configuration:"default",split:"test"}}) as Awaited<ReturnType<typeof imports.inspectHuggingFace>>;
      expect(job.inspection?.metadata.selectedPreview).toEqual({configuration:"default",split:"test"});
      const input={action:"import_source",payload:{importId:job.id,operationId:"selected-rows",name:"Selected sample",objective:"Check examples",rows:[0],promptField:"id",expectedField:"answer"}};
      const saved=await datasets.request(input) as {record:LocalDatasetRecord};
      expect(saved.record.workspace.draft.tasks).toHaveLength(1);
      expect(saved.record.workspace.draft.tasks[0]).toMatchObject({input:{prompt:"row-1"},expectedOutput:{text:"2"}});
      const snapshot=JSON.parse(Buffer.from(saved.record.workspace.files[0]!.base64,"base64").toString());
      expect(snapshot).toMatchObject({split:"test",selected:[{index:0,row:{id:"row-1",answer:"2"}}],transformation:{promptField:"id",expectedField:"answer"}});
      expect(saved.record.workspace.draft.sourceRefs[0]).toMatchObject({licensingStatus:"approved",secretScanStatus:"passed",piiScanStatus:"passed",metadata:{scope:"Selected inspection preview",previewRevisionVerified:false,privacyScanner:"openpond-evidence-v1",findings:[]}});
      expect((await datasets.request(input) as {record:LocalDatasetRecord}).record).toEqual(saved.record);
      await expect(datasets.request({...input,payload:{...input.payload,rows:[24]}})).rejects.toThrow(/outside/);
      const calls=request.mock.calls.length;await datasets.read(saved.record.workspace.draft.id);expect(request.mock.calls).toHaveLength(calls);
      const recheck={action:"check_sources",id:saved.record.workspace.draft.id,expectedRevision:1,operationId:"recheck-source",payload:{}};
      const reviewed=await datasets.request(recheck) as {record:LocalDatasetRecord};
      expect(reviewed.record.workspace.draft.revision).toBe(2);
      expect(reviewed.record.workspace.files).toEqual(saved.record.workspace.files);
      expect((await datasets.request(recheck) as {record:LocalDatasetRecord}).record).toEqual(reviewed.record);
      expect((await datasets.read(saved.record.workspace.draft.id,1)).workspace).toEqual(saved.record.workspace);
      // A declared license or public source never bypasses findings in the
      // actual captured bytes; retain the draft but block its qualification.
      previewAnswer="sk-SYNTHETIC_NOT_A_REAL_KEY_123456789";declaredLicense="unknown";
      const unsafeJob=await datasets.request({action:"inspect_source",payload:{url:"org/dataset",configuration:"default",split:"test"}}) as Awaited<ReturnType<typeof imports.inspectHuggingFace>>;
      const unsafe=await datasets.request({...input,payload:{...input.payload,importId:unsafeJob.id,operationId:"unsafe-sample"}}) as {record:LocalDatasetRecord};
      expect(unsafe.record.workspace.draft.sourceRefs[0]).toMatchObject({licensingStatus:"review",secretScanStatus:"blocked",metadata:{findings:["OpenAI-style API key"]}});
      expect(unsafe.record.workspace.draft.tasks[0]?.expectedOutput).toEqual({text:previewAnswer});
      const failed=await datasets.request({action:"validate",id:unsafe.record.workspace.draft.id,expectedRevision:1}) as {record:LocalDatasetRecord};
      expect(failed.record.checks[0]?.status).toBe("failed");
    }finally{await store.close();await rm(home,{recursive:true,force:true});}
  });

  test("rejects metadata that exceeds the inspection byte limit", async () => {
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    const request = vi.fn(async () =>
      new Response(oversized as unknown as BodyInit));

    await expect(inspectHuggingFaceDataset(
      normalizeHuggingFaceDatasetLocator("org/dataset"),
      request as unknown as typeof fetch,
    )).rejects.toThrow("metadata exceeded its byte limit");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function json(value: unknown): Response {
  return Response.json(value, {
    headers: { "content-length": String(JSON.stringify(value).length) },
  });
}
