# Local datasets and large PDF corpora

Local datasets do not use the hosted 64 MiB publication envelope as an aggregate storage limit. Import an authored folder through the installation's authenticated CLI so the PDFs are captured from disk; do not put a large corpus into one HTTP request body.

The folder contains `taskset.json` and its declared input, verifier and fixture files. `datasets import --local` creates a local dataset. To replace the files and authored document of an existing ordinary local dataset, put the absolute folder path in a small input file:

```json
{"path":"/absolute/path/to/authored-folder"}
```

```sh
openpond datasets save DATASET_ID --local --input-file folder-input.json \
  --expected-revision CURRENT_REVISION --operation-id UNIQUE_OPERATION_ID --json
openpond datasets validate DATASET_ID --local --expected-revision SAVED_REVISION --json
openpond datasets check-graders DATASET_ID --local --expected-revision SAVED_REVISION --json
```

Use the same operation ID and unchanged input after an uncertain save response. The CLI observes local dataset operations for up to twenty minutes; an observer timeout is not proof that a saved operation failed. Folder replacement preserves dataset ownership and revision history; it cannot replace a Model-owned draft or a published draft. Capture rejects symlinks and files that change while being read. This operation does not upload, publish or authorize training.

For Profile workflow runs, use `experiments prepare-profile`, `run-profile` and `inspect-profile` with the exact saved revision, workspace hash, Profile and task selection. The run package retains only selected task inputs and calibration dependencies, while its source authority remains the complete saved dataset revision. Gold answers and verifier assets stay private.

Hosted upload clients and the default SDK compilation boundary retain their 64 MiB envelope. The small local HTTP request-body and file-editor limits remain transport limits, separate from aggregate folder capture. The current local workspace/package format still materializes bytes in memory; removing its aggregate 64 MiB cap does not make gigabyte-scale imports streaming.
