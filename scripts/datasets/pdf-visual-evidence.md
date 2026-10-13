# Rendered PDF source evidence

Use `prepare_pdf_visual_evidence.py` during offline Dataset authoring when policy inputs contain prepared PDF evidence. Text extraction alone can retain a long template while omitting filled content painted as vectors or images. This tool renders and OCRs **every page**, preserves existing text/widgets, and binds the results to the original PDF SHA256. It never reads expected answers or private graders.

Requirements: Python with PyMuPDF and Tesseract with English language data. The tool records the renderer/OCR versions, rendering parameters, raster hashes and OCR text hashes. An explicit `--tesseract` path supports a locally unpacked runtime without changing the app server or system installation.

```sh
python3 scripts/datasets/prepare_pdf_visual_evidence.py \
  --source /absolute/path/source.pdf \
  --evidence /absolute/path/existing-prepared-evidence.json \
  --output-directory /absolute/path/visual-evidence
```

The evidence remains `needsVisualReview: true`. Inspect the generated pages and OCR for the fields the task needs, including dates, form positions, checkbox answers and ambiguous text. OCR is source evidence, not a completed answer; retain printed typos and flag uncertainty rather than silently correcting them.

After inspection, create a review manifest with `sourceSha256` and one ordered entry for each page: `page`, `reviewed: true`, `renderedPageSha256` and `textSha256`. Apply it through `qualify_visual_review` before copying the evidence into the authored task context, or pass it with `--review` on a reproducible preparation run. The qualification function rejects omitted/duplicated pages, another source, changed OCR and stale review hashes. Missing OCR tools, failed OCR or empty output fail preparation rather than accepting the text template.

Copy the reviewed `visualText` and its provenance into policy-visible prepared evidence. Keep gold answers and verifier files private. Save, validate, calibrate and prepare/run the new Dataset revision through the official OpenPond CLI. This helper only processes offline files; it does not implement authentication, Dataset API calls, publication or experiment execution.

Regression boundary:

```sh
python3 -m unittest discover -s scripts/datasets -p test_pdf_visual_evidence.py
```

The Storage Scholars r6 evidence fix is recorded in [the working doc](../../docs/working-docs/training/2026-10-12-storage-scholars-local-experiments-and-training-path.md). Existing immutable Profile releases are unchanged: this is a fix to the prepared policy inputs and their authoring qualification, not a new model-visible OCR capability.
