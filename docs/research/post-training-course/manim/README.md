# Post-Training from First Principles — ManimGL Course

This is a first-principles visual course and the primary companion to [Post-Training as Signal Routing](../../2026-07-20-post-training-signal-routing.md). It uses the original [3b1b/manim](https://github.com/3b1b/manim) engine, distributed on PyPI as `manimgl`.

## Watch

- [Full narrated course — 29:20](videos/lessons/full-course.mp4) — all ten lessons in one continuous, upload-ready video with a matching WebVTT caption file
- Narrated learning series — ten focused lessons with individual captions and LLM-ready Markdown scripts (`script_01.md` through `script_10.md`) that open from each lesson row in the app's right panel:
  1. [How post-training works — 1:05](videos/lessons/01-how-post-training-works.mp4)
  2. [Definitions — 6:14](videos/lessons/02-definitions.mp4)
  3. [On-policy and off-policy data — 1:06](videos/lessons/03-on-policy-off-policy.mp4)
  4. [Rewards and credit assignment — 3:00](videos/lessons/04-rewards-credit-assignment.mp4)
  5. [Verifiable rewards — 2:53](videos/lessons/05-verifiable-rewards-rlvr.mp4)
  6. [PPO and GRPO — 2:54](videos/lessons/06-ppo-grpo.mp4)
  7. [Distillation — 2:42](videos/lessons/07-distillation.mp4)
  8. [OPSD, SDFT, and SDPO — 2:43](videos/lessons/08-opsd-sdft-sdpo.mp4)
  9. [Credible experiments — 3:32](videos/lessons/09-credible-experiments.mp4)
  10. [Technical appendix — 3:12](videos/lessons/10-technical-appendix.mp4)
- [Narrated core course — about 26 minutes](videos/PostTrainingFromFirstPrinciplesNarrated.mp4)
- [Silent core master — 26:08](videos/PostTrainingFromFirstPrinciples.mp4)
- [Narrated advanced appendix — 3:12](videos/PostTrainingAdvancedAppendixNarrated.mp4)
- [Silent advanced appendix — 3:12](videos/PostTrainingAdvancedAppendix.mp4)

The core follows the causal training process: a policy produces behavior, the environment evaluates it, credit assignment connects outcomes to actions, and an optimizer updates the policy. Concrete examples stay in the visuals rather than becoming narration about the course structure.

### Part I — Foundations

1. [Choose, judge, update](videos/lessons/01-how-post-training-works.mp4) — a policy chooses among patches, tests judge the sampled repair, loss tracks the written objective, and training changes the next distribution
2. [Definitions](videos/lessons/02-definitions.mp4) — policy notation, separate logits and softmax explainers, temperature, rollouts, log-probabilities, concrete reward examples, return, advantage, gradients, dedicated PPO/GRPO definitions, baselines, clipping, distribution metrics, and acronym references
3. [Where data came from](videos/lessons/03-on-policy-off-policy.mp4) — a one-minute explanation of on- versus off-policy sources, concrete rollout fields, stored-data schemas, and objective routing
4. [From outcomes to credit](videos/lessons/04-rewards-credit-assignment.mp4) — the repair becomes an inspect–edit–test trajectory; sampled actions versus observations, reward versus feedback, return, advantage, exploration, and reference KL

### Part II — Methods

5. [Verifiable rewards](videos/lessons/05-verifiable-rewards-rlvr.mp4) — whether the cancellation tests are trustworthy; RLVR, verifier errors, reward hacking, and hidden evaluation
6. [PPO and GRPO](videos/lessons/06-ppo-grpo.mp4) — PPO compares a repair with a learned critic; GRPO compares sibling patches; worked advantage, clipping, group contrast, and zero-variance groups
7. [Distribution matching](videos/lessons/07-distillation.mp4) — a teacher exposes alternatives at the next cancellation token; hard and soft targets, token cross-entropy, temperature, KL direction, prefix provenance, and privileged context
8. [Teacher evidence](videos/lessons/08-opsd-sdft-sdpo.mp4) — the failed repair is revisited with privileged solutions, demonstrations, or structured diagnostics through OPSD, SDFT, and SDPO

### Part III — The lab

9. [Credible experiments](videos/lessons/09-credible-experiments.mp4) — turn the one repair into a versioned code-repair Taskset, then define information boundaries, baselines, metrics, compute accounting, replications, and paper claims

### Advanced appendix

10. [Technical appendix](videos/lessons/10-technical-appendix.mp4) — GRPO length normalization and pass@k, top-k teacher-logit storage, OPSD/SDFT/SDPO paper-result charts, and SRPO success/failure signal routing

The detailed [study script](course_script.md) supplies definitions, paper links, and the core idea behind each visual. The shorter [production narration](narration_script.md) adds examples and causal explanations without reading the screen verbatim.

Rendered MP4s are placed under `videos/` by the course render configuration. Every empirical graph is labeled `PAPER-REPORTED`; conceptual diagrams are labeled separately.

## Visual and editorial choices

- The visual system uses a muted-black structural field with selective semantic color for policies, teacher distributions, rewards, failures, and mathematical curves.
- The animation grammar is 3Blue1Brown-inspired: persistent mathematical objects, animated transformations, open diagrams, restrained text, and minimal interface chrome.
- Slide titles are one to four words; explanatory claims live in smaller subtitles, diagrams, or bottom takeaways.
- Each slide has one short title and one explanatory subtitle; the section label sits quietly in the lower-right.
- Method names appear beside the mechanism that gives them meaning; the narration expands each acronym on first use.
- Every major method includes explicit `APPLIES TO` and `POOR FIT` examples grounded in math, code, tools, and agent training.
- Persistent source/chapter footer metadata is removed; paper names appear beside the mechanisms they introduced or in the study script.
- The core retains the causal learning path. Specialized normalization, systems, and paper-result material lives in the optional appendix.
- The course stays focused on reinforcement learning mechanics. Token imitation appears only as an off-policy data schema or experimental control, not as a standalone lesson.
- Empirical graphs are labeled `PAPER RESULTS` or `REPORTED RESULT`; invented teaching numbers are explicitly labeled `CONCEPTUAL`, `WORKED EXAMPLE`, or `ILLUSTRATIVE`.

## Render

ManimGL requires Python 3.7+, FFmpeg, OpenGL, and Pango. LaTeX is not required for these scenes.

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
bash render_course.sh
bash render_appendix.sh
```

## Narration

The reproducible [narration pipeline](narration/README.md) uses the OpenAI Speech API with the pinned `gpt-4o-mini-tts-2025-12-15` model, Cedar voice, and speed `1.10`. Human-editable scripts, manifests, raw WAV responses, fitted audio, full narration masters, and final narrated MP4s are stored with the course. The API key remains external to the repository.

Every lesson opens with a brief OpenPond reveal, its own title, and one sentence explaining what it teaches. Narrated outputs identify the generated voice in audio metadata and provide timed WebVTT captions without adding a disclosure outro to the learning sequence.

Package the existing chapter renders and fitted narration tracks as the web learning series without making new Speech API calls:

```bash
node scripts/tutorials/build-post-training-series.mjs
```

## Local and CDN media

Only MP4 files are published to R2. Posters, captions, and lesson scripts remain regular assets in `apps/web/public`, where they are cheap to ship and easy to edit. The local MP4s are ignored by Git and excluded from production bundles. `pnpm dev` reads them locally, so an unfinished lesson can be rebuilt and reviewed without uploading anything. Restore a clean checkout from the public, checksum-verified objects with `pnpm media:pull`.

Prepare the checked-in manifest after changing any video:

```bash
pnpm media:prepare
```

The manifest records each playlist's lifecycle status plus every logical video ID, local source path, byte size, duration, SHA-256 digest, and immutable key `media/videos/<sha256>.mp4`. Both video builders refresh it automatically. The continuous full-course video is referenced by `fullVideoId` and deliberately excluded from the lesson `videoIds`. Because each key represents one file's content, rebuilding one lesson produces one new lesson object plus a new continuous-course object rather than replacing unrelated media. The learning UI reads the post-training playlist's `draft` or `published` status directly from this manifest.

Publish exactly the manifest entries from the infrastructure repository. The command preflights every local hash before changing R2, skips matching objects, rejects mismatches, uploads only missing objects, and verifies public range playback:

```bash
cd ../sandbox && ./cli --production cloudflare r2 publish-videos --manifest ../openpond/apps/web/src/lib/public-video-manifest.json --source-root ../openpond/apps/web/public --confirm-upload
```

Then verify the complete production set from OpenPond:

```bash
pnpm media:verify
```

Production builds use `https://media.openpond.ai` with the manifest keys directly; there is no media environment variable and no Cloudflare credential in OpenPond. Never replace a content-addressed key. The Sandbox publisher is intentionally idempotent, so rerunning it after a one-video edit uploads only that video's new digest.

To render one chapter:

```bash
manimgl course.py Chapter05GRPO -w -l
```

The course script produces a readable 720p export with ManimGL's `-m` flag. Use `-l` for a fast 480p proof, or `--hd` for a 1080p export.

## Source of truth

- Equations, caveats, exact tables, and annotated bibliography: [research paper](../../2026-07-20-post-training-signal-routing.md)
- Implementation phases and OpenPond code anchors: [working doc](../../../working-docs/training/2026-07-20-post-training-research-lab.md)
