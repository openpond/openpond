# Desktop evaluation workspace parity

Status: implementation and qualification in progress. This is focused evidence for Phase 6 of the Sandbox gold-standard working document; the parent owns that document and its acceptance checkboxes.

Latest checkpoint: September 30, 2026, SDK 0.9.9 / CLI and Desktop 0.2.43 source qualification. The deployed staging service remains the coordinated `5c6ee098` / `c86aa207` lineage with published SDK 0.9.8 and CLI 0.2.42. SDK 0.9.9 collection filtering/optional-query omission and native 0.2.43 exact task selection, retained Setup, selected execution/pass pins, guards, supported sampling controls and original receipt accounting are prepared for the next grouped release; source readiness does not establish deployed or final packaged acceptance. The official Dataset audit exposed two package aliases for one exact Reward, so this release includes canonical alias consolidation with feedback-key conflict rejection and retained alias provenance.

Actual proofs already pass for native Console, independent Dataset/Grader authoring and released versions, original seven trace events/restart, retained-output scoring/shared comparison, withdrawn adoption, operation recovery, global History and official Discover. Latest native [guard proof](/tmp/desktop-ui-guards-final-proof/report.json) passed at 20:06 UTC; [Visibility proof](/tmp/desktop-ui-visibility-proof/report.json), [withdrawn adoption proof](/tmp/desktop-retained-adoption-proof-native/report.json), [folder capture/retry proof](/tmp/desktop-folder-import-proof-native/report.json) and [Linux 0.2.42 AppImage proof](/tmp/desktop-packaged-42-workflow-proof/report.json) retain their actual artifact boundaries. The folder proof did not exercise the native OS picker. Fresh SDK 0.9.9 source full check passed 32 files/87 tests, packed consumer, protocol fixtures and package dry run in `/tmp/desktop-sdk-09-alias-fullcheck.log`. Combined native/server TSC and meaningful population/receipt/route boundaries passed. [Official alias source proof](/tmp/desktop-official-grader-alias-source-proof.json) applies the candidate canonical helper to actual deployed population pins without mutations or provider calls; deployed API default and native Save remain pending matching activation.

Remaining gates are the SDK 0.9.9 registry install and matching host activation, official Dataset alias/task-selection Save acceptance, explicit Start and uncertain-response/restart recovery under the authorized separate $0.05 rejection and $1/two-execution ceilings, Project/scope restoration, active-work cancellation, multi-page retained traces, qualified execution composition/genuine local execution, and the final packaged 0.2.43 workflows. Phase 6 is not yet accepted. Chat/Work capture, default Ponder Pal Project, Refiner, Training handoff and Continual Learning are deferred to independent specs.

Related document: [Datasets, evaluations and graders gold standard](/home/glu/Projects/all/sandbox/docs/working-docs/ui-ux/2026-09-29-datasets-evaluations-gold-standard.md).

## Product decision

Desktop provides native Datasets, Graders and Experiments pages over the same hosted SDK/services as the web console and CLI. Console opens the native workspace and keeps its product selection and navigation highlighting. Models retains its existing local authoring, labeling, rewards, training, versions and serving workflows.

Project scope identifies the hosted Training Project, independently of Model selection. Account/team/Project changes invalidate resource queries and inspector state. Editors and inspectors occupy one content-pushing right column. Saving setup retains a revision; Start is explicit. Retained-output scoring creates a separate pass. Reading, comparing or reopening results creates no target execution.

## Current code

- `apps/server/src/training/hosted-evaluation-workspace.ts`: resolves the saved server account/team, reauthorizes Project/resource membership, and invokes authoritative SDK operations. Credentials remain behind this boundary.
- `apps/server/src/training/hosted-dataset-authoring.ts`: shares existing draft/file/package helpers and independent hosted save/publish lifecycle.
- `apps/server/src/training/hosted-grader-attachment.ts`: resolves an exact Reward revision and its immutable asset closure using the shared compiler before saving an attachment through existing dataset CAS.
- `apps/web/src/components/labs/workspace/`: peer resources, authoring adapters, grading, retained cases and shared comparison views. The existing Reward editor/calibration and dataset editor are reused.
- `apps/web/src/components/labs/models-route.ts`: canonical native Models/Console routes, resource tabs, hosted Project scope and retained execution/pass links.
- `packages/sdk/src/{experiment-inspection,grader-inspection}.ts`: bounded authorized inspection clients. Dataset workspace SDK methods retain begin-version operation identity and immutable published history.
- Sandbox `lib/sandbox/experiments/case-inspection.ts`: authorizes run/population/child identities before reading policy-facing input/messages. Private expected answers and environment snapshots are omitted.
- Sandbox `lib/sandbox/tasksets/dataset-workspaces.ts`: immutable version history and explicit begin-editable-version transition reuse existing workspace operation receipts/locks and owner fences.

## Boundaries

Hosted dispatch, grading, billing, refund, cleanup and cancellation remain authoritative service operations. Desktop introduces no duplicate compute or billing engine. Operation keys are scoped to account/team/Project and survive Desktop changing its local server port.

Published datasets and graders retain exact release hashes. Starting an editable dataset version preserves previous published bytes, identity and pins. Attachment changes apply only to the editable version and do not update old experiments.

The parent owns the common execution contract for model-only, model plus Harness, model plus Harness plus Profile, and genuine local execution. Desktop must consume qualified versions of those contracts; hosted API calls made from Desktop do not establish local execution acceptance. Marketplace integration requires its coordinated qualified contracts. The user deferred Chat/Work capture, default Ponder Pal Project and Refiner to their independent spec, alongside the previously separated Training handoff and Continual Learning work. Those features do not gate this Desktop delivery. Experiment/Profile/Work target runtime composition remains in scope.

## Qualification

### Native shell and resource navigation

- [x] Canonical peer routes preserve hosted Project ownership and reject Model-prefixed peer routes. Done: existing route-boundary suite passes all three tests, including Project and native Console roundtrips.
- [x] Actual Electron opens staging Datasets and a retained native Experiment with its real model, feedback and usage. Done: retained-workspace harness report below.
- [x] Console menu click remains native with Console product state and resource highlighting. Done: actual Electron Console menu journey passed; direct/back/reopen parity remains part of the broader recovery gate.
- [ ] Complete resource names/breadcrumbs, scoped pagination/search/sort, empty/error recovery and selected Project restoration in development and packaged Desktop.

### Authoring and released associations

- [x] Native Grader creation, independent positive/negative fixture checks, two published versions, editable feedback key, and older-version inspection. Done: actual Electron authoring proof and exact SDK release reads; zero model calls.
- [x] Native Dataset creation, task/private-answer authoring, objective/fixture editing, exact older-grader attachment, two publications and immutable version inspection. Done: actual Electron proof; original published workspace remained byte-identical and two private verifier/fixture assets retained; zero provider calls.
- [ ] Complete folder import, stale revisions and duplicate/uncertain operation response acceptance.
- [ ] Verify exact older grader attachment, private asset closure, calibrated judge reuse, saved-draft resume and unchanged old releases.
- [x] Native marketplace Discover opens a content-pushing sidebar, imports the exact release into an ordinary Dataset, and verifies included grader fixtures with zero provider calls. Done: actual Electron marketplace proof.
- [x] Native publisher metadata/license/explicit distribution consent, exact public publication and withdrawal preserve the released Dataset. Done: visibility revisions1/2; no target calls.
- [ ] Verify retained imported policy tasks and exact reusable grader alias pins after source withdrawal; policy tasks already read successfully, alias resolver fix awaits shared activation.

### Experiment lifecycle and evidence

- [x] Retained native result survives actual Electron close/reopen unchanged and the case inspector pushes content. Done: isolated Electron proof; zero target calls created.
- [x] Actual native case reader shows retained input and seven original trace events; evidence is unchanged after Electron restart. Done: fresh coherent server bundle and deployed host inspection proof, preserving durable sequences 100302–100308.
- [ ] Qualify multi-page retained trace reads and complete cross-owner/team/error recovery acceptance.
- [x] Native Apply grader selects exact older Reward v1, completes separate retained-output passes, uses the shared comparator and preserves original execution/result after Electron restart/reopening. Done: September 30 17:22 proof below; zero target calls.
- [ ] Verify setup revisions, explicit Start, stable identity across retry/reconnect and real execution cancellation/cleanup through Desktop.
- [ ] Complete qualified execution composition/local controls once the parent’s shared contracts are available.

### Packaged acceptance

- [x] Packaged native Console navigation, retained input/seven original trace events and unchanged results after packaged Electron restart. Done: actual Linux unpacked app reports below, zero target calls.
- [ ] Run complete authoring/lifecycle/recovery/composition against the final packaged source batch.

## Validation

Passed source checks:

- `node_modules/.bin/tsc -b apps/server apps/web --pretty false`
- `pnpm --dir packages/sdk run build`
- `node_modules/.bin/vitest run apps/web/src/components/labs/lab-primary-tab-state.test.ts --reporter=dot`: one file, three route-boundary tests.

Actual development app: launched using `pnpm dev`; server `http://127.0.0.1:17874` and renderer `http://127.0.0.1:17876`, then stopped that owned process before the isolated harness.

Actual Electron proof command:

```sh
node_modules/.bin/tsx scripts/desktop-harness.ts run .git/desktop-evaluation-proof/retained-workspace.mts --isolated --skip-build --timeout-ms 180000 --artifacts-dir /tmp/desktop-evaluation-retained-proof --json /tmp/desktop-evaluation-retained-proof/report.json
```

[Passed report](/tmp/desktop-evaluation-retained-proof/report.json), September 30 at 14:33 UTC. Explicit staging API `https://staging-api.openpond.ai`, QA team `mddpdc823sf1qxbc3dazzd5j`, definition `exp_a57a5971-a448-4121-b054-1ab09fe76455`, execution `mrun_fe9e36f9-4ddb-4dc1-bf8c-7e905a8b7216`. The native run retained score 1, 2,877 measured tokens and $0.000498 measured spend. Inspector width was 431.33px; the main content’s right edge equaled the panel’s left edge. Results were identical after Electron restart. This proof created zero target calls.

[Passed native Console report](/tmp/desktop-console-navigation-proof/report.json), September 30 at 14:59 UTC. Actual product-menu click retained the local renderer origin, selected `/console/datasets`, displayed `OpenPond product: Console`, highlighted Datasets, and then navigated natively to `/console/experiments`. The Console sidebar contained Datasets, Graders and Experiments. This proof also created zero target calls.

[Passed retained inspection/restart report](/tmp/desktop-evaluation-retained-proof-verified/report.json), September 30 at 15:47 UTC. The live reader retained its policy-facing input and all seven original durable trace sequences (100302–100308), omitted expected answers, and kept execution/results unchanged after Electron restart. Zero target calls.

[Passed native marketplace report](/tmp/desktop-marketplace-sidebar-proof/report.json), September 30 at 15:38 UTC. Discover preserved `/console/datasets` while its right sidebar pushed content. Import retained public release `dataset-public-bdfa997700d1727e7099752b9d0b7a649b380d37`, exact Dataset/package hashes, and the grader asset closure in Personal team `aepuajr0gxc2pg8ebigd7a0w`, hosted Dataset `hwr0vym53js32valef3gfnxz`. Included verifier fixtures passed with zero provider calls. Policy-task viewing depends on the coordinated new population endpoint deployment.

[Passed native Grader authoring report](/tmp/desktop-grader-authoring-proof/report.json), September 30 at 15:53 UTC. Created `reward-7265f58c-ca35-4d50-a0cc-43e592ab5904` in the QA workspace, authored feedback key `desktop_pond_accuracy`, checked independent positive and negative JavaScript fixtures, published two immutable releases, and inspected revision 1 unchanged after revision 2. Exact retained references are in [the source proof](/tmp/desktop-native-grader-authoring-proof.json). Zero provider calls.

The earlier proof's host inspector 404 was resolved by deployment `50422cf2a`. One obsolete isolated proof used an older server bundle against the newer renderer inventory shape and was stopped; coherent current bundle verification passed. The trace proof initially assumed sequences began at 1; its corrected assertion verifies the original durable ordering.

## Open dependencies

- SDK0.9.8 is published/installed and its History, recovery, population, exact adopted grader and catalog categories readers are live. Next grouped SDK0.9.9/CLI+Desktop0.2.43 source carries collection filtering and native Setup/selection; its host activation and actual native proofs remain pending.
- Population source and canonical shared grader-pin read are implemented; new Setup controls must be verified against their deployed versions.
- Parent common app-server execution composition and genuine local execution contracts.
- Shared Experiment/Profile/Work target execution controls remain in scope; Chat/Work capture, default Ponder Pal, Refiner and Training/Continual Learning were deferred by the user and do not gate this delivery.
- Dataset uncertain-response recovery source is complete and its SDK/lifecycle boundary checks pass. The real API proof is prepared: commit a save then drop its reply, advance another revision, recover the original receipt without a second write, reject changed intent/wrong transition/wrong Dataset and omit foreign-workspace operations. This proof awaits coordinated activation.

## Progress log

- September 30: shared server facade, independent hosted authoring adapter, flat grader inspection APIs, authorized retained case reader, canonical peer routes and content-pushing panel implemented. Source checks passed and merged with SDK 0.9.6 through PR 485.
- September 30: added explicit editable dataset version transition and bounded immutable version browse/read using existing CAS, actor ownership and operation receipts.
- September 30: isolated Electron retained-result/restart proof passed. A real source review found the retained scoring request’s extra `revision` field would violate the strict immutable execution ref; the correction is included in the continuation source.

- September 30: combined population/marketplace SDK check passed. Released Setup membership and exact grader mappings, Grader preset choices/feedback-key editor, authoring close guards, and concise native Discover were added. Native retained inspector/restart, marketplace adoption/check and Grader authoring/version proofs passed against live staging.

[Passed native Dataset authoring/version report](/tmp/desktop-dataset-authoring-proof/report.json), September 30 at 16:24 UTC. Dataset `dataset-11f37a5f-938d-492f-ae8a-b56193385c39` published workspace revisions 5 and 8. It attaches `reward-7265f58c-ca35-4d50-a0cc-43e592ab5904` revision 1 while revision 2 exists, preserving both private assets. Exact releases/package hashes are in [the source proof](/tmp/desktop-native-dataset-authoring-proof.json). The former Dataset detail cache kept its old revision after closing an editor; refreshing that selected query and disabling actions during refresh fixed the actual publication failure. Zero provider calls.

September 30 package checkpoint: production renderer, server bundle, Desktop build, runtime stage (251 files, 26.21 MiB), and Linux unpacked package built successfully. Actual packaged Console menu/navigation proof passed. Retained inspector/restart proof passed with shell readiness that accepts a restored Console route; full packaged acceptance remains pending. Artifact `release/linux-unpacked/openpond-desktop`; app ASAR SHA-256 `633bb3ca1589502eb07b46666f9a757b7bdecb0501aa1fd5e62dc572899bf246`. Snapshot uses SDK 0.9.7 source plus uncommitted Desktop continuation; parent owns the release source commit.

[Passed packaged retained report](/tmp/desktop-parity-packaged-retained-proof/report.json), September 30 at 16:28 UTC. Actual Linux unpacked Desktop reads the same authorized input, seven original trace sequences and exact Experiment result after restart. The [Console packaged report](/tmp/desktop-parity-packaged-proof/report.json) first scenario passes native product navigation; its initial second scenario used an incorrect New-chat-only readiness assertion on the restored Console route, corrected in the separate passed retained report. Zero target calls.

[Passed native publisher visibility report](/tmp/desktop-publisher-visibility-proof/report.json), September 30 at 16:31 UTC. The exact published synthetic Dataset from the native authoring proof became Public with explicit license/distribution consent, then Private at revision2. Retained Dataset bytes remained identical. [Source proof](/tmp/desktop-native-publisher-visibility-proof.json).

SDK 0.9.8 continuation source: compact global Experiment history reuses the existing authenticated run-store paging/actor/Project query and filters Experiment rows before paging. It returns definition/summary/target pins without cases or private answers. Dataset recovery reuses actor-owned operation receipts and immutable original base/result snapshots, reconstructs the original request hash, and returns the same receipt after later edits without another write. Full SDK package check, server/renderer TSC and six meaningful SDK/lifecycle/route boundary tests passed. Final registry install, deployed host and real injected dropped-response proof remain pending.

The retained-adoption proof confirmed public detail rejects after withdrawal and authorized policy tasks still read without expected answers/object locations. It exposed an existing alias gap: the package grader ID differs from its retained reusable Reward ID. Canonical resolution now reads the existing exact taskset_graders association only for the same Dataset id/revision/hash and verifies Reward bytes/implementation. Setup and Experiment admission share this fix; its activation/proof remains pending.

Latest release readiness: SDK History/recovery source is frozen for SDK 0.9.8. The native `marketplaceCategories` facade now delegates to the canonical anonymous categories projection, keeping search/paging independent from category choices. The presentation agent fixed the renderer target compatibility issue; parent reports current full server/renderer TypeScript and web build checks pass. Current artifact must be rebuilt after the combined release snapshot.

[Passed native retained scoring/shared comparison report](/tmp/desktop-retained-scoring-proof-final/report.json), September 30 at 17:22 UTC, coherent CLI/server/Desktop 0.2.42 snapshot. Exact Reward `reward-7265f58c-ca35-4d50-a0cc-43e592ab5904` revision 1 creates completed passes `score_7b8b6f94-e3fd-4458-b50c-2ae2d522cbc5` and `score_8f081950-5d6e-44bf-b004-2caf8ac38ece`, feedback `desktop_pond_accuracy=1`. Shared comparison returns compatible populations and zero score change. Original native execution and result remain byte-identical after actual Electron restart and reopening the exact pass. [Source proof](/tmp/desktop-native-retained-scoring-proof.json). Zero target calls; whole setup/Start/recovery/composition gates remain pending. Harness initially looked for an aria-label as visible text, clicked the Compare navigation tab instead of its action, and assumed a direct scripted route restores automatically; bounded corrected readiness/action/reopen checks pass.

Native full setup proof found a genuine pre-dispatch blocker: `modelChoices` for the authored Dataset’s valid `test` split returns hosted HTTP 400, surfaced by the Desktop facade as HTTP 500. The shared choices response schema hardcodes train/validation/frozen_eval while the canonical Evals TaskSplitSchema also permits test. The actual attempt-choices projection then fails its response schema. Parent has the exact canonical schema repair and owns release coordination. `/tmp/desktop-experiment-lifecycle-proof/report.json`; zero target executions were created. Full setup/Start is not accepted.

The canonical TaskSplitSchema repair is included in SDK 0.9.8; its existing public transport boundary now accepts `test` and rejects unknown splits. Sequential full SDK package check passed in `/tmp/desktop-task-split-sdk-check.log`. The real native setup proof awaits the matching host activation.

[Passed Linux 0.2.42 AppImage report](/tmp/desktop-packaged-42-workflow-proof/report.json), September 30 at 17:41:31 UTC. Actual packaged Desktop retains authorized input, original trace sequences 100302–100308 and unchanged results across packaged Electron restart. A second actual packaged workflow authors/checks a JavaScript grader with independent positive/negative fixtures, publishes versions 1/2 and reads version 1 unchanged; exact receipts are in [the packaged authoring proof](/tmp/desktop-packaged-grader-authoring-proof.json). These two workflows created zero target calls. Parent's final stage/package inventory contains 251 identical runtime files and 27,509,824 bytes; all package caps passed in `/tmp/evaluation-runtime-history-desktop-budget.log`. Broader packaged setup/recovery/composition acceptance remains pending.

Native continuation source now pages definition executions/scoring passes and reads explicitly linked retained executions/passes independently of the first page. Direct links validate the execution's Experiment identity and selected pass's execution identity before result reads. Configuration uses the selected execution's actual model/Dataset/Project/budget and exact retained definition revision rather than substituting the latest editable setup. Cases stays mounted across detail tabs for the same execution/pass so its registered inspector/grading actions survive navigation. Dataset Experiment associations use the existing authorized `datasetHash` filter before host paging rather than filtering the first global inventory page. Canonical native source typecheck passed; actual acceptance of this continuation awaits the next coherent bundle.

The Dataset API route dispatch now disambiguates ordinary Dataset IDs `operations`/`population` from operation recovery/population actions using their canonical query markers. This adds no reserved Dataset IDs and changes no actor/private-byte boundary. Sandbox source is frozen for the parent's grouped host snapshot.

[Passed actual deployed Dataset operation recovery proof](/tmp/desktop-dataset-recovery-api-proof.json), September 30 after worker activation of `5c6ee098f35ee6bf8c9d313ad15736f038205d6b` (identity `44074b2dc3cd955b830f1d48d309892b859ad949d290bd4f84877c97a8017ff3`). Dataset `dataset-recovery-c3132ce8-45be-4ce3-8753-9a17411d77f5` commits revision2, loses its actual response, then advances to revision3 through another intent. Retrying the original intent returns the byte-identical revision2 receipt without a second write and leaves revision3 unchanged. Changed intent, wrong transition and wrong Dataset are rejected; a foreign Personal workspace cannot retrieve the operation. Zero provider calls. Full native folder/stale-revision/lifecycle recovery acceptance remains pending.


## September30 native continuation checkpoint

Actual deployed API proofs passed for actor-owned lost-response recovery, withdrawn-adoption exact grader resolution/private-input exclusion, canonical `test` split model choices, and independent official public facets. Native imported Dataset read after withdrawal passed at19:06:23 UTC in [the retained adoption report](/tmp/desktop-retained-adoption-proof-native/report.json), preserving Personal Dataset `hwr0vym53js32valef3gfnxz` and the original release hash. Zero provider calls.

Actual native authored-folder capture/recovery and Task reader passed at19:17:48 UTC in [the folder report](/tmp/desktop-folder-import-proof-native/report.json). After the admitted folder was changed locally, retry returned the same original workspace hash and Tasks. This qualifies server capture plus native read; the report explicitly records that the native OS folder picker was not exercised. Zero provider calls.

The native global History proof passed at19:06:31 UTC after the facade omitted absent optional query fields. The published SDK previously serialized explicit `undefined` Project/cursor properties as literal query values; SDK0.9.9 source now omits them at the canonical client boundary. DatasetWorkspace and released Catalog collection filters include authorized Project associations, search, and deterministic keyset sorting before paging. Setup's Dataset picker continues to include all authorized releases. Full SDK source check passed31 files/86 tests, packed consumer, protocol fixtures and package dry run in `/tmp/desktop-sdk-09-query-fullcheck.log`; package metadata was still0.9.8 during that candidate check and the parent owns the0.9.9 release.

The improved native Setup proof exposed a genuine pre-dispatch schema error: Desktop added `split` to strict Experiment population members. This is removed in the next native source. No target was dispatched by that failed proof. Native0.2.43 source now retains one workspace-scoped Setup draft while Review navigates to the exact Dataset Tasks table, supports whole-release or explicit cross-page task subsets with count feedback, prevents checkbox events from opening Task inspectors, and leads with Dataset/evaluation followed by model/budget. Seeds and other settings are collapsed. Unpublished editable tasks are excluded from executable published-release selection. Historical authored Dataset and Grader links carry revision/hash pins across refresh. These changes have passed renderer/server typechecking and await the coherent grouped artifact and host activation.

Original receipt accounting now crosses a narrow server projection only after exact execution/manifest/population-member validation. Private Attempt metadata is omitted; unknown cost/tokens stay unknown and Compute appears only when explicitly retained. When a scoring pass is selected, original execution accounting is labelled separately from that pass's measured grader-only flat usage. One meaningful root-unit metadata/identity boundary test and combined renderer/server TSC passed in `/tmp/desktop-case-usage-boundary-test.log` and `/tmp/desktop-native-projection-typecheck.log`.

The native scoring Cancel action was exercised, but the one-task JavaScript pass completed concurrently before cancellation took effect. That terminal race is preserved in `/tmp/desktop-scoring-cancellation-proof-native/report.json`; active-work cancellation remains unqualified. The pristine Project-scope probe also remains open: a read-only editor workspace request silently prevented navigation; the next source limits the draft busy lock to actual writes. Both require actual followup proofs.

The next authorized lifecycle probe will record any $0.05 maximum-reservation rejection without dispatch, then separately qualify a distinct one-task/64-output-token definition under an explicitly documented $1 whole-execution ceiling, at most two target executions for lost Start response/restart/intentional rerun. Neither ceiling is assumed spend. Full Phase6 and final packaged lifecycle/composition gates remain pending.
