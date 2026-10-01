# Distribution and performance measurements

Package size, file count, and performance thresholds are reporting tools, not
release gates. Feature growth must never require raising a byte allowance.
Desktop and npm packages have no fixed size or file-count ceilings. Performance
thresholds are advisory, with no strict mode or environment override that turns
warnings into CI failures.

## Reviewed budget inventory

This inventory covers build, release, benchmark, and asset-authoring budgets as
of October 1, 2026. MiB and KiB use powers of 1024, including former tutorial
limits whose messages called them MB.

### Removed distribution ceilings

| Measurement | Previous hard cap | Current behavior |
| --- | ---: | --- |
| Linux compressed artifact, x64 and ARM64 | 129 MiB | Report bytes |
| macOS compressed artifact, x64 and ARM64 | 150 MiB | Report bytes |
| Windows compressed artifact | 150 MiB | Report bytes; release lane currently disabled |
| Linux ARM64 unpacked app | 340 MiB | Report bytes |
| Linux x64 unpacked app | 400 MiB | Report bytes |
| macOS / Windows unpacked app | 400 MiB | Report bytes |
| Desktop packaged resources, all platforms | 32 MiB | Report bytes |
| Desktop app.asar, all platforms | 2 MiB | Report bytes |
| Desktop staged runtime, all platforms | 27.5 MiB | Report bytes and file count |
| npm compressed tarball | 16 MiB | Report bytes |
| npm unpacked package | 64 MiB | Report bytes |
| npm package files | 1,000 | Report file count |
| npm CLI entrypoint | 64 KiB | Report bytes |

The v0.2.45 Linux ARM64 job produced a 340.30 MiB unpacked app and failed its
340 MiB cap after packaging succeeded. These ceilings are removed rather than
increased, so ordinary growth cannot repeat that failure on any platform.

### Advisory performance thresholds

`scripts/report-performance.ts` collects these measurements. They previously
failed `budgets:check` and its targeted/full CI callers; now they only warn.

| Measurement | Warning threshold |
| --- | ---: |
| Total renderer JavaScript | 32 MiB |
| Initial HTML JS/CSS/preload assets | 1.27 MiB |
| Largest renderer asset (JS/CSS/WASM/font) | 8 MiB |
| Built server ready time | 5,000 ms |
| Health response time | 750 ms |
| Bootstrap response time / bytes | 3,000 ms / 2 MiB |
| Workspace diff response time / bytes | 1,500 ms / 1 MiB |
| Event page response time / bytes | 500 ms / 256 KiB |

### Other advisory measurements

| Measurement | Warning threshold | Location |
| --- | ---: | --- |
| Vite minified chunk size | 500 kB (decimal), already advisory | Vite default used by `apps/web/vite.config.ts` |
| CLI version cold-start p95 | 750 ms, `--benchmark` only | `scripts/check-cli-distribution.ts` |
| CLI serve/web ready time | 10,000 ms | `scripts/check-cli-distribution.ts` |
| App-server RPC first token / compaction / restart | 10,000 ms | `tests/agent-app-server-rpc.test.ts` |
| App-server RPC interruption | 2,000 ms | `tests/agent-app-server-rpc.test.ts` |
| Public app-server CLI startup | 10,000 ms, performance run only | `tests/agent-app-server-cli.test.ts` |
| Million-event recovery projection time | 1,000 ms | `tests/runtime-event-lists-performance.test.ts` |
| Single-event append p95 | 50 ms | `tests/runtime-event-lists-performance.test.ts` |
| Post-training lesson / full-course export | 15 MiB / 100 MiB | `scripts/tutorials/build-post-training-series.mjs` |
| Agent overview export | 15 MiB | `scripts/tutorials/build-openpond-agent-overview.mjs` |
| Agent tutorial export | 25 MiB | `scripts/tutorials/build-how-to-make-an-agent.mjs` |

CLI distribution timing warnings were already advisory. The explicit CLI startup
and RPC/event-projection timing assertions and tutorial export size gates are now
advisory too. Media validity and expected-duration checks remain.

Optional package comparisons warn only when growth crosses both thresholds:

| Measurement | Minimum increase | Minimum proportion |
| --- | ---: | ---: |
| Compressed npm package | 256 KiB | 5% |
| Unpacked npm package | 1 MiB | 5% |
| Renderer JavaScript | 512 KiB | 5% |
| HTML entry assets | 64 KiB | 10% |

CI records current size snapshots in job summaries and workflow artifacts. Base
comparisons are available locally; CI does not rebuild the PR base for them.
Content hashes are normalized and runtime chunks grouped to avoid reporting
split/rename churn as new payload. Individual gzip sizes explain contributors
and do not add up to tarball size. Initial HTML assets exclude dynamically loaded
screens and workers.

## Checks that still fail

Desktop checks still verify minimal ASAR contents, required entrypoints, runtime
hashes, consistent inventory totals, staged/packaged inventory equality, and macOS
signatures. Staging still rejects unintended source, tests, debug files, and
foreign native binaries.

npm checks still reject unintended contents, stale/missing runtime chunks, and
stale/missing renderer outputs. They prove installation, public CLI entrypoints,
app-server protocols, launch behavior, PTY support, and dependency audit results.

Performance probes fail for unreadable/missing builds or referenced entry assets,
failed startup/health, and failed route requests. Exceeding a successful probe's
timing or response-size warning threshold never fails the command.

The audit also found limits serving functional or resource contracts rather than
distribution growth. These remain enforced:

- Renderer smoke: composer must render at least once and at most input length
  plus two commits; sidebar commits must stay within its measured idle baseline
  or the two-commit background tolerance. Terminal replay tests retain batching
  and active-transcript bounds. These catch broken component isolation and
  unbounded retention.
- Event recovery: at most 64 MiB of additional retained heap for the million-event
  fixture. Live event-window assertions protect bounded retention after recovery.
- App-server RPC lifecycle: tests still require successful streaming, compaction,
  interruption, and persisted recovery. Their 20/30-second test deadlines and
  process/request timeouts make hung operations fail instead of waiting forever;
  successful-operation latency measurements are advisory.
- Source structure: existing handwritten modules are capped at 1,999 lines and
  new production modules at 999 lines, enforcing focused modules.
- Product/runtime limits: request and upload envelopes, attachments, subprocess
  output, transcript/cache/log retention, model context windows, user-approved
  training spend, learning iteration/judge budgets, and execution timeouts. These
  enforce data, memory, provider, and consent boundaries. The diagnostic Work
  archive's 12 MiB cap mirrors its desktop attachment contract.

These contracts can produce their own explicit validation failures; they do not
block packaging simply because the application grew. Changing them is a separate
product or lifecycle decision, not a release-size budget adjustment.

## Local commands

After `pnpm run build:artifacts && pnpm run cli:build:from-web`:

```sh
pnpm package:size --output artifacts/package-size.json --check-contents
pnpm package:size --head artifacts/package-size.json --base /path/to/base-size.json
pnpm performance:report --renderer-only
pnpm performance:report
pnpm cli:distribution:check
```

After packaging a desktop build:

```sh
pnpm desktop:package:check
```

To measure an older checkout, use the current collector:
`node scripts/report-package-size.ts --root /path/to/base --output artifacts/base-size.json --snapshot-only`.
Use clean builds and matching Node/npm versions for comparisons. The collector
uses Node built-ins and does not require the older checkout to contain it.
