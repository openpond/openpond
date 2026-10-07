# Local memory and model benchmarks

Use `benchmark-memory.mjs` for fresh-process app RSS and `benchmark-local-model.py`
for a real CPU model plus the packaged app under one Linux cgroup limit. These
measure different things: process RSS includes shared pages, while the cgroup
accounts for charged anonymous memory, file pages, tmpfs and kernel memory.

## App measurement

```sh
pnpm tvc:package
node examples/turnkey-agent/packaging/benchmark-memory.mjs --executable dist/turnkey-agent/openpond-tvc --runs 3
```

The app benchmark uses a synthetic model reply to isolate runtime overhead. It
records startup latency, ready RSS, first-turn RSS and peak RSS without an
inspector or forced GC. `--bundle path/to/app.cjs` measures the same fixture with
the current Node executable. Compare bundles on the same Node version; a static
packaged executable has a different runtime/memory layout.

Measured locally on 2026-10-06, three fresh processes per row:

| Artifact | Ready RSS | After first turn | Peak RSS | Median startup |
| --- | ---: | ---: | ---: | ---: |
| Before optional composition, Node 24.18.0 | 371.75 MiB | 380.28 MiB | 380.28 MiB | 895 ms |
| After optional composition, Node 24.18.0 | 258.64 MiB | 274.82 MiB | 274.82 MiB | 669 ms |
| After optional composition, static Node 24.20.0 | 241.75 MiB | 250.84 MiB | 251.46 MiB | 785 ms |

The comparable Node bundle first-turn reduction is **105.45 MiB (27.7%)**. Frozen
baseline: commit `fada3c4ce`, bundle SHA-256
`327c383779edcaf824afd4f7b6ebc3337ea64c2c895f4718497dede22ff14539`.
After bundle SHA-256:
`cb75b83b2d82409e1eb981edbdb5f1ce9cd241263e0a06480fd3d7abaa9647c8`.
Static artifact SHA-256:
`3a556af1a7d3ff907a0d65021ff356ad0a39f03faa81786db8dd52661dfb7ef8`.
These final artifacts also passed the packaged integration check.

## Real 0.6B inference

Prerequisites: Linux cgroup v2 delegated to a user systemd service, Python 3,
`sha256sum`, enough `/dev/shm` space for one model copy, and a CPU `llama-server`.
The benchmark rejects any cgroup configuration other than 1 GiB with zero swap.
Use a fresh unit for each invocation so `memory.peak` and events start fresh.

```sh
systemd-run --user --wait --pipe --collect \
  -p MemoryMax=1073741824 -p MemorySwapMax=0 -p OOMPolicy=continue \
  python3 "$PWD/examples/turnkey-agent/packaging/benchmark-local-model.py" \
  --model /absolute/path/Qwen_Qwen3-0.6B-Q4_K_M.gguf \
  --llama-server /absolute/path/llama-server \
  --executable "$PWD/dist/turnkey-agent/openpond-tvc" \
  --output "$PWD/tmp/model-baseline"
```

The controller streams a fresh model copy into tmpfs **inside the measured
cgroup**, starts the model and app, asks for a plain reply, and then requests
three distinct hashes. Every hash must match a real `sha256sum` execution and
the model's final answer. The HTTP sandbox fixture validates the bound identity,
credential and exact command grammar; it invokes `sha256sum` without a shell.
It does not implement Firecracker isolation. Model answers are never stubbed.

Defaults: CPU threads 2, context 4096, one slot, batch/microbatch 128, Q8 KV cache,
no model repacking, no idle RAM prompt cache, flash attention on, thinking off.
`--kv q4_0` allows a separate lower-memory KV experiment. Weights remain Q4_K_M.
The single model slot can reuse a common prompt prefix across requests, so the
plain reply measures cold prefill and subsequent tool timings are warm-prefix
measurements. Three successful hashes establish this bounded tool path, not
broad model quality or long-context reliability.

Pinned inputs:

- Model: `bartowski/Qwen_Qwen3-0.6B-GGUF`, revision
  `60b85c0e3d8fe0f6474f406922a26d12aca4550d`, file
  `Qwen_Qwen3-0.6B-Q4_K_M.gguf`, 484,220,320 bytes, SHA-256
  `9acfc1e001311f34b4252001b626f2e466d592a42065f66571bff3790d4e1b14`.
- llama.cpp: `b11457`, commit `5ad1c5da0`, Linux x64 CPU build; archive SHA-256
  `210eaa41a16e0d24fa44071cb62f95702ef903c84d86506d6482ac919bcee078`.

Observed Q8 KV run: plain reply 56.1 s, three warm-prefix tool turns 15.1–17.0 s,
all three hashes verified. Combined cgroup usage after the turns was 923.8–935.0
MiB. Startup/staging reached the configured 1 GiB cap, with 1,387 `max` events and zero OOM/kill events.
This passes the enforced cap but does **not** establish peak headroom.

The Q4 KV experiment failed to qualify: the plain reply hit the app's 300-second
deadline (HTTP 504), without an OOM. It is not the recommended baseline. This
single experiment does not establish the reason for its output/latency failure.

`result.json` records artifact hashes, limits, phase memory samples, process RSS
peaks, authoritative cgroup peak/events, responses and timings. `app.log` and
`model.log` provide diagnostics. Peak includes staging and reclaimable file
cache; examine phase samples and `memory.events` before claiming headroom.
The staged model is removed and both children are stopped on normal completion
or handled failure. An externally killed controller can leave its temporary
model directory behind.

This is a local Linux compatibility/memory measurement. The model runtime is a
normal dynamically linked Linux binary; this does not prove inference in QOS,
TVC, an enclave, or a complete enclave filesystem/image budget.

The checked-in [numeric baseline](memory-baseline.json) preserves all app RSS samples, final model phase measurements and the unsuccessful Q4 trial summary.
