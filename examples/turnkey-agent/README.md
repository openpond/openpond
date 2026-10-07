# OpenPond inside Turnkey Verifiable Cloud

The embedded example runs the **real OpenPond app-server, SQLite, harness and turn loop**, plus SmolLM2 135M Instruct Q4_K_M, inside one enclave. Inference uses a private loopback llama.cpp process. The app requires **no egress and no model-provider API key**. Its public `/chat` endpoint still requires a caller bearer token; only the token's SHA-256 is included in deployment configuration.

Every request creates and removes a temporary OpenPond home. This version provides single-turn text chat: no tools, internet, durable history or resume API. The embedded model adapter uses the same concise instruction as the fixed harness, preserves user/assistant messages, and omits generic desktop tool/skill instructions for capabilities this deployment does not expose. Sampling is deterministic. It permits one active request, at most 1024 UTF-8 prompt bytes and 256 output tokens, with a 4096-token context and a five-minute deadline. Desktop integration is separate work; `/chat` is an agent endpoint, not a model-provider endpoint.

Qwen3 0.6B passed local real inference at the 1 GiB limit, but its 579 MB pivot cannot fit QOS's [128 MiB boot-message limit](https://github.com/tkhq/qos/blob/qos_core-v0.12.1/src/qos_core/src/protocol/mod.rs#L20). SmolLM2 is the smaller self-contained fallback. XZ compression brings the complete package below 127 MiB, reserving room for the manifest in the boot message. The model is packaged and verified locally; no startup download or external inference is used.

## Build embedded inference

Prerequisites: installed workspace dependencies, Python 3, CMake, a Linux x64 C++ toolchain with static system libraries and liblzma, binutils, curl and Docker for verification.

```sh
pnpm tvc:typecheck
pnpm exec tsx --test examples/turnkey-agent/local-model/package.test.ts
python3 examples/turnkey-agent/packaging/local-model/launcher.test.py
bash examples/turnkey-agent/packaging/local-model/package.sh
# Or reuse a previously downloaded model (the SHA-256 is still checked):
# bash examples/turnkey-agent/packaging/local-model/package.sh /path/to/SmolLM2-135M-Instruct-Q4_K_M.gguf
```

The build pins llama.cpp commit `5ad1c5da0ad7f6176256b823925aad19134f0263` and checks its source archive hash. A small patch passes an already-positioned file handle to upstream's `llama_model_load_from_file_ptr`: GGUF tensors map directly from the approved executable. The outer static launcher decompresses one inner executable into a private temporary directory. The app then extracts only the 18 MB static inference engine, **never another copy of the 105 MB weights**. Both appended regions are SHA-256 checked at startup. A bounded, validated trailer identifies their offsets.

`dist/turnkey-agent-local-model/openpond-tvc` is the complete compressed pivot. Its adjacent `openpond-tvc.manifest.json` records the final pivot and inner runtime hashes and sizes. `openpond-runtime.manifest.json` records engine/model offsets and hashes. The launcher bounds decompression, verifies the XZ checksum, supervises signals and removes its extracted payload after child exit. Do not deploy the unextended executable from `dist/turnkey-agent` with embedded configuration.

The app uses pinned prebuilt static Node 24.20.0 (`yao-pkg/pkg-fetch` v3.6), verified against SHA-256 `83223146550e6dce2e773e1668b397aab63664e820ac40551f9df16b0d8b276f`, packaged with `@yao-pkg/pkg` 6.23.0. Its adapter initializes `HOME=/tmp` before the pkg bootstrap because QOS has no passwd database. Embedded builds set a 128 MiB V8 old-space limit and 4 MiB semi-space limit. Native llama.cpp allocations and tmpfs are additional memory. This is a pinned third-party runtime, not an independently reproduced StageX build.

## Verify the complete memory budget

```sh
docker build -f examples/turnkey-agent/packaging/local-model/Containerfile.check \
  -t openpond-tvc:embedded-check dist/turnkey-agent-local-model
python3 examples/turnkey-agent/packaging/local-model/check.py \
  --image openpond-tvc:embedded-check --output tmp/tvc-inference/check
```

The check copies the entire executable into charged executable tmpfs under a **1 GiB cgroup, zero swap, two CPUs, no network, no inherited app environment, no passwd database and a read-only root**. It performs real generation through OpenPond, authentication rejection, input bounds, concurrent-request rejection, client cancellation, state cleanup and capacity recovery. It records cgroup peak/events and responses. Both the compressed outer file and decompressed runtime are charged to the same cgroup. Read the recorded peak and events rather than inferring headroom from process RSS. The test image contains a staging shell; the published transport image below contains only the pivot.

## Configure, publish and deploy

Copy `packaging/embedded-config.example.json` to a private working location. Generate a high-entropy caller token and set only its lowercase SHA-256 in `authTokenSha256`. Keep the token out of image layers, public manifests, argv and logs. Leave app egress disabled and deployment debug mode off.

```sh
docker build --platform linux/amd64 -f examples/turnkey-agent/packaging/Containerfile \
  -t YOUR_REGISTRY/openpond-tvc:YOUR_TAG dist/turnkey-agent-local-model
docker push YOUR_REGISTRY/openpond-tvc:YOUR_TAG
docker buildx imagetools inspect YOUR_REGISTRY/openpond-tvc:YOUR_TAG
```

Follow [Turnkey's quickstart](https://docs.turnkey.com/features/verifiable-cloud/quickstart) for organization/app/operator registration. `packaging/deployment.example.json` documents deployment fields: use the supported QOS version, your app ID, **linux/amd64 manifest digest**, final embedded pivot hash, and `/openpond-tvc` path. Set `pivotArgs` to `["--config-json", JSON.stringify(publicConfig)]`. Create and approve the manifest with the registered operator, verify readiness, then select the live deployment. TVC extracts the pivot; the rest of the container filesystem is unavailable at runtime.

`GET /health` reports model readiness. `POST /chat` accepts exactly `{"prompt":"..."}` with `Authorization: Bearer ...` and returns `{requestId, answer, threadId, turnId, tools:[]}`. Supply `TVC_AUTH_TOKEN` securely to the client environment:

```sh
node examples/turnkey-agent/local-model/client.mjs https://YOUR_APP_DOMAIN
```

Deadline, client disconnect and shutdown abort the local inference HTTP call and close per-request state. The model process is reused and stopped on shutdown. A failed model makes readiness fail; there is no automatic restart or replay. Ingress uses ordinary HTTPS; this example does not add end-to-end encrypted client-to-enclave transport or client attestation verification.

## Connect from the desktop

Open Settings → Providers → Add model. Enter the endpoint URL and caller API key, fetch models, choose its display name and add it. Select the saved model under Models from URL in the regular chat composer. The same flow supports OpenAI-compatible API base URLs and endpoints without authentication. Choose an existing provider or Create new provider and give it a name; its models appear together under that name. Each connection keeps its own encrypted key.

This embedded endpoint receives only the current message; the desktop transcript is not remote model context. Stop cancels the request. Attachments, connected apps and local profile workflows are unavailable for this endpoint.

## External-service fixture and memory profiling

The explicit `external` mode retains the original model → external sandbox → model example. Configure `packaging/public-config.example.json` and use `client.mjs` with `TVC_AUTH_TOKEN`, `OPENAI_API_KEY` and `OPENPOND_API_KEY`. That mode needs app egress and an existing sandbox bound to its configured team. It is not the embedded no-egress deployment.

`pnpm tvc:package` builds the smaller app-only static executable and verifies startup, HTTP authentication, fixed sandbox binding, real app-server tool orchestration, timeout/no retry and cleanup against synthetic local upstream fixtures. `pnpm tvc:bundle` plus `pnpm tvc:check` runs the same boundary without packaging.

For source-mapped retained-heap profiling and fresh-process RSS measurements, see [Memory measurement and the earlier dynamic-model baseline](packaging/MEMORY.md). Those earlier numbers exclude the full embedded pivot and must not be presented as the enclave's complete memory budget.

Pinned model: [SmolLM2 135M Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct) (Apache-2.0), [GGUF conversion](https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/tree/09816acd5d99df7be770d85ea30822623dab342c) at revision `09816acd5d99df7be770d85ea30822623dab342c`, file SHA-256 `2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d`. [llama.cpp](https://github.com/ggml-org/llama.cpp/tree/5ad1c5da0ad7f6176256b823925aad19134f0263) is MIT licensed. Preserve upstream license obligations when distributing builds.

## Verified deployment

The [2026-10-07 release evidence](packaging/embedded-release-proof.json) records the immutable image and pivot hashes, three healthy non-debug replicas with egress disabled, authenticated real remote answers and the complete local cgroup/lifecycle check. The diagnostic deployment was deleted after acceptance.
