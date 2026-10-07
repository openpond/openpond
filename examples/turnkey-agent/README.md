# OpenPond inside Turnkey Verifiable Cloud

This example embeds the **real OpenPond app-server** in a static Node executable. Each authenticated request creates a temporary SQLite home and harness, runs the existing model/tool loop, and removes its local state. The only tool computes a UTF-8 string's SHA-256 through the existing external Firecracker sandbox API. Its sandbox and team are bound by deployment configuration.

Local bundle and static-executable integration are verified. Actual QuorumOS execution remains unverified; fixture success is not a TVC or Firecracker proof. Model inference and sandbox execution remain outside the enclave, and credentials/content pass through ordinary HTTPS ingress. This is an ephemeral compatibility example, not a confidential end-to-end service.

## Build and local verification

From the repository root with dependencies installed:

```sh
pnpm tvc:typecheck
pnpm tvc:bundle
pnpm tvc:check
```

The check runs the bundle from an isolated directory without repository dependencies. It exercises real app-server startup, authentication before inference, fixed tenant binding, model → tool → model, timeout without retry, cleanup, and capacity recovery using synthetic upstream fixtures.

Package using the prebuilt static Linux x64 Node runtime (no Node source compilation):

```sh
pnpm tvc:package
```

The script pins `@yao-pkg/pkg` 6.23.0 and Node 24.20.0 `linuxstatic-x64` from `yao-pkg/pkg-fetch` release `v3.6`. It verifies the downloaded runtime against SHA-256 `83223146550e6dce2e773e1668b397aab63664e820ac40551f9df16b0d8b276f` before packaging, and caches it in `PKG_CACHE_PATH` (default `~/.pkg-cache`). It then rejects ELF files with a dynamic loader or shared-library requirements, records `dist/turnkey-agent/executable.sha256`, and runs the integration check against the final executable. Source is embedded without bytecode generation. The pinned packager adapter sets `HOME=/tmp` before the pkg bootstrap runs because QuorumOS provides no home-directory environment or passwd database; application code runs too late to fix that assumption. This pins a third-party prebuilt runtime; it does not claim an independently reproduced StageX build.

Build/publish the transport image using your approved registry tag:

```sh
docker build --platform linux/amd64 -f examples/turnkey-agent/packaging/Containerfile \
  -t YOUR_REGISTRY/openpond-tvc:YOUR_TAG dist/turnkey-agent
node examples/turnkey-agent/packaging/check-minimal.mjs YOUR_REGISTRY/openpond-tvc:YOUR_TAG
docker push YOUR_REGISTRY/openpond-tvc:YOUR_TAG
docker buildx imagetools inspect YOUR_REGISTRY/openpond-tvc:YOUR_TAG
```

The minimal-environment check launches with no environment, no passwd database, no network, a read-only root, and a 1 GiB memory cap.

### Profile startup memory

```sh
pnpm exec tsx scripts/build/bundle-tvc.ts --profile
node examples/turnkey-agent/packaging/profile-memory.mjs
# Optional large V8 heap snapshot for inspecting retainers:
node examples/turnkey-agent/packaging/profile-memory.mjs --snapshot
# Linux RSS before/after a real app-server turn (three fresh processes):
node examples/turnkey-agent/packaging/benchmark-memory.mjs
# Compare a preserved bundle or the final static executable:
node examples/turnkey-agent/packaging/benchmark-memory.mjs --bundle /path/to/baseline/app.cjs
node examples/turnkey-agent/packaging/benchmark-memory.mjs --executable dist/turnkey-agent/openpond-tvc
```

The separate profile bundle includes source maps and an esbuild module inventory. The profiler starts allocation sampling before module loading, initializes the real app-server in a temporary home, forces GC after readiness, and records memory plus source-mapped allocation sites in a new `tmp/tvc-profile/capture-*` directory. It uses synthetic configuration and makes no inference or sandbox request. The child shuts down and its temporary home is removed. `summary.json` records the Node version and bundle hash. Allocation samples estimate retained allocations, not precise ownership or reclaimable savings; instrumented RSS is not the production RSS baseline. The normal bundle and packaged executable are untouched.

The RSS benchmark uses a local synthetic model fixture and the real chat runtime, without an inspector or forced GC. Each run gets a fresh process and temporary home; it checks the response and records startup RSS, first-turn RSS, and the process high-water mark from `/proc`. Reports under `tmp/tvc-profile/benchmark-*` include the artifact hash, all samples, and medians. Compare both live heap and first-turn RSS: V8 allocation/GC thresholds can make RSS move differently from retained heap. Run the complete integration check against any candidate profile bundle with `node examples/turnkey-agent/check.mjs --bundle dist/turnkey-agent-profile/app.cjs`.

Record the **linux/amd64 manifest digest**, not a multi-platform index digest. TVC extracts `/openpond-tvc`; the container filesystem is not available to the running program. Required skills/assets are embedded and extracted to a private temporary directory at startup. Local project compilation and terminal execution are unavailable.

## Configure and deploy

Copy `packaging/public-config.example.json` to a private working location. Configure the model endpoint, model, existing sandbox ID, and its exact team ID. Generate a high-entropy caller token; put only its lowercase SHA-256 in `authTokenSha256`. Keep the token and upstream credentials out of manifests, image layers, arguments, and logs. Requests supply `modelApiKey` and `sandboxApiKey` in their authenticated JSON body.

Follow [Turnkey's quickstart](https://docs.turnkey.com/features/verifiable-cloud/quickstart) to log in with an API key registered to the intended organization, initialize an app/operator, and generate the deployment template. Startup and `/health` require no egress, so they can be deployed first. Agent turns need outbound HTTPS; confirm organization egress enablement and enable egress on the app before testing real inference/tools.

`packaging/deployment.example.json` documents the deployment fields. Use the supported QOS version from the current CLI/docs, your app ID, immutable image digest, and the packaged executable hash. Set `pivotArgs` to `["--config-json", JSON.stringify(publicConfig)]`, where the second element is one JSON string. Ports must match public config. Create and approve the deployment with the registered manifest operator. Keep debug off for the acceptance run; a debug app needs a separate quorum key and is not attested proof.

For local live-service testing, run the packaged executable with the same public configuration:

```sh
dist/turnkey-agent/openpond-tvc --config-json "$(cat /path/to/public-config.json)"
```

Supply `TVC_AUTH_TOKEN`, `OPENAI_API_KEY`, and `OPENPOND_API_KEY` securely to the client environment, then run:

```sh
node examples/turnkey-agent/client.mjs https://app-YOUR_APP_UUID.turnkey.cloud
```

The client uses synthetic text, validates both the sandbox evidence and final answer against a locally computed digest, and prints only sanitized identifiers/digest. It never retries. Keep the app/deployment/manifest identity, debug status, image/executable hashes, health result, and real sandbox command ID with the run evidence.

## Failure and lifecycle behavior

Requests are bounded to 64 KiB, model output and tool rounds are limited, and concurrency is capped (default one). Each turn gets a fresh runtime, and deadline/disconnect/shutdown abort outbound calls and close local state. A response lost after sandbox submission does **not** prove the remote command was cancelled. The fixed read-only hash command requests a 15-second sandbox execution limit; this example neither owns nor deletes the configured sandbox. Inspect ambiguous remote outcomes before another request. There is no durable history, automatic replay, or resume API.
