<div align="center">
  <h1>OpenPond</h1>
  <p><strong>Team based agents, turning Chats into Trainable Datasets.</strong></p>
  <p>
    <a href="https://github.com/openpond/openpond/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/openpond/openpond/actions/workflows/ci.yml/badge.svg" /></a>
    <a href="https://www.npmjs.com/package/openpond"><img alt="npm package version" src="https://img.shields.io/npm/v/openpond?logo=npm&logoColor=white" /></a>
    <img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white" />
    <img alt="Language: TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript&logoColor=white" />
  </p>
</div>

OpenPond is an open-source harness/Desktop App/CLI that turns conversations into **durable team based agents** and **training-ready** tasks/jobs across whatever model path you want: BYOK providers, hosted OpenPond models, open source models, or the LLM subscriptions you already pay for.

- We aim to provide feature parity with the Codex (ChatGPT now?) desktop app but fully opensource and geared towards moving your work product into trainable agents/models of all levels.
- Feel free to use this repository as a drop in replace for the Codex app, while using your OpenAI/Codex, Z.ai and any other API or subscription based LLM service. 
- We also provide premium features related to: Team communication in app, Agent hosting on our Sandbox infra, OAUTH connections, and Managed training service (coming soon). Find out more: OpenPond Cloud [(docs)](docs/public/cloud.md)

Explore Desktop, CLI, TUI, model access, goals, Cloud, Connect, and other capabilities in the [public docs](docs/public/README.md).

## Agents & Skills

Our agents and skills exist as a first class git backed citizen called Profiles, and follow our agents-sdk package. Sync your profile with Openpond Premium to share with your team. This helps you ship softeware to your non technical teammembers. You can also chat in app with your team members and use agents directly in chat in a slack-like experience.

Learn how they are stored and when to use each one in the [Agents and skills guide](docs/public/agents-and-skills.md).

## Training From Real Work

Select your chats, add them to a dataset and let our model suggest what training algorithm (SFT, RL, GRPO etc.) is best suited to speed up your work and save you money on frontier model mistakes. Currently working with local models, but tasksets (datasets/jobs) can be exported to Runpod, Prime Hosting, or work with Openpond Manged Training (coming soon).

See how conversations become reviewable Tasksets and training bundles in [Training from real work](docs/public/training.md).

## Hybrid: Local <> Cloud

Hybrid mode allows you to use your subscriptions on your local machine, while editting your code on our cloud sandboxes. We spin up a sandbox for you coding sessions and the harness overtakes your local editting tools and instead uses our sandboxed tools.

Learn what stays local and how sandbox changes come back in the [Hybrid execution guide](docs/public/local-cloud.md).

## Quick Start

Prerequisites:

- Bun
- Node.js `>=20.19 <21` or `>=22.12`

Install dependencies and start the local app:

```bash
bun install
bun run dev
```

`bun run dev` launches the desktop development flow. If an app is already running, keep using the existing process instead of starting another one.

## Common Commands

| Command | Use |
| --- | --- |
| `bun run dev` | Start the watched app server, Vite renderer, and Electron desktop app. |
| `bun run dev:web` | Start the watched app server and renderer for browser development. |
| `bun run dev:server` | Start only the watched local app server. |
| `bun run dev:web:renderer` | Start only the renderer against an existing server. |
| `bun run cli` | Run the source CLI entrypoint. |
| `bun run terminal` | Start the source terminal UI; it connects to or starts the local server. |
| `bun run typecheck` | Build-check the app TypeScript project-reference graph. |
| `bun run verify:quick` | Run the workspace typecheck and isolated unit suite. |
| `bun run test` | Run unit, integration, contract, and release suites. |
| `bun run build` | Typecheck and build the server, web, and desktop artifacts. |
| `bun run verify:push` | Run the complete local equivalent of the required CI gate. |

## Repository Layout

```text
apps/
  cli/            # published openpond/op CLI and bundled runtime assets
  desktop/        # Electron main process, preload, and packaging config
  server/         # local API, persistence, orchestration, and training services
  terminal/       # server-backed terminal UI
  web/            # React renderer shared by desktop and browser mode
packages/
  agent-sdk/       # agent authoring SDK, CLI, templates, examples, and evals
  cloud/           # OpenPond API, profile, Git, and hosted-workspace clients
  codex-provider/  # Codex app-server provider integration
  connected-apps/  # shared connected-app catalog and capability contracts
  contracts/       # shared schemas and cross-process TypeScript contracts
  runtime/         # provider-neutral turn, tool, and orchestration primitives
  taskset-sdk/     # Taskset validation, materialization, graders, and baselines
  training-sdk/    # training plans, bundles, destinations, and adapters
python/
  openpond-training/ # optional local training and inference worker
docs/
  public/          # user-facing product and workflow guides
  working-docs/    # implementation plans, investigations, and evidence
scripts/           # dev supervision, builds, verification, and release tooling
tests/             # root unit, integration, contract, live, and smoke tests
packaging/         # platform packaging policy and release metadata
```

## Development Flow

Install from the repository root and keep the root workspace as the source of truth for shared changes. `bun run dev` supervises the server, renderer, and Electron processes together; if that stack is already running, use it instead of starting a second copy.

Make contract changes in `packages/contracts` first, then update the owning SDK/runtime, the server API, and finally the web, desktop, CLI, or terminal consumer. Keep generated output in ignored `dist`, `stage`, release, or temporary directories.

Use the narrowest relevant checks while iterating, then run the full gate before pushing:

| Change area | Focused checks |
| --- | --- |
| Shared runtime, server, web, or desktop | `bun run typecheck`, then `bun test <relevant-test-file>` |
| CLI | `bun run cli:typecheck`, then `bun run cli:test` |
| Agent SDK | `bun run agent-sdk:check` |
| Taskset SDK | `bun run --cwd packages/taskset-sdk typecheck`, then `bun run --cwd packages/taskset-sdk test` |
| Training SDK | `bun run --cwd packages/training-sdk typecheck`, then `bun run --cwd packages/training-sdk test` |
| Python training worker | `uv run --project python/openpond-training pytest` |
| Cross-package or pre-push | `bun run verify:push` |

The Python worker requires Python `>=3.10,<3.13` and `uv`; neither is required for the normal Desktop, web, CLI, or TUI development loop.

## Quality Gates

`bun install` configures the repository-owned pre-push hook in `.githooks`. Every push runs the canonical verifier below and rejects either a failed check or a test/build that changes source files:

```bash
bun run verify:push
```

CI executes the same quality, unit, integration, contract, and release-artifact gates in parallel, then reports one required `Checks` result. Release builds wait for that result and reuse the verified source artifacts across the platform matrix instead of rebuilding and retesting each target.

Coverage badges should be added only after coverage is collected and uploaded by CI. Until then, the CI badge is the accurate project health signal.

## Publishing Notes

The CLI package lives in `apps/cli` and is published as `openpond` with the `openpond` and `op` binaries. Stable tags publish npm provenance and GitHub CLI/Desktop artifacts only after the supported-platform smoke reports pass. Nightly tags publish GitHub artifacts without creating an npm version. See the [CLI guide](docs/public/cli.md) and [packaging policy](packaging/README.md).

## License

OpenPond is available under the [MIT License](LICENSE).
