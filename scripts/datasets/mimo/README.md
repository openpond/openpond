# Retain and upload the original MiMo sources

`prepare.py --root <directory> --inventory <reviewed inventory JSON>` captures the pinned Xiaomi MiMo V2.6 RL Parquet files, verifies their hashes and row counts against the reviewed source inventory, and prepares task prompts. It requires Python with PyArrow installed.

`pnpm exec tsx scripts/datasets/mimo/upload.ts --root <directory> --home <OpenPond home> --team <workspace id>` builds retained workspaces. Add `--apply` to upload them using the saved `openpondai` production account. The account handle and API origin are checked before any write. Retained bytes and operation IDs are reused for retries; receipts verify the saved content hashes and task counts.

These are source drafts. The original Parquet files remain privileged, and visible task inputs contain the original prompts. Publication and scoring still require the native environment adapters, private grader dependencies, source reviews, and runtime qualification. General also needs its separate upstream environment assets. These scripts do not substitute a synthetic scorer or mark those requirements complete.

Code environment qualification must also address the [Vals AI audit of October 7, 2026](https://www.vals.ai/blogs/mimo-reward-hacking): reference solutions can survive as unreachable Git objects, and solution-specific modification times can reveal patch scope. Build agent-visible environments from the pinned base source, exclude future Git objects and solution artifacts, normalize file timestamps, isolate hidden tests, and verify the resulting image rather than relying only on command restrictions. Preserve the original source snapshot separately for provenance.
