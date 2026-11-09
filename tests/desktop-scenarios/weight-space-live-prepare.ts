import { createHash } from "node:crypto";
import { canonicalSha256, parseAndVerifyWeightSpacePrepare, parseAndVerifyWeightSpaceExecutionReceipt } from "openpond-sdk/training";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import { reloadRenderer, waitForRendererCondition, waitForSidebarSessionRow } from "./helpers";

async function retainedSessionEvents(harness: DesktopHarness, sessionId: string) {
  const events: Record<string, any>[] = [];
  let afterSequence = 0;
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    const page = await harness.api.eventPage<{ events?: Record<string, any>[]; items?: Record<string, any>[] }>({ sessionId, afterSequence, limit: 500 });
    const entries = page.events ?? page.items ?? [];
    events.push(...entries.map(entry => entry.event ?? entry));
    if (entries.length < 500) return events;
    const next = Math.max(...entries.map(entry => Number(entry.sequence ?? entry.event?.sequence ?? 0)));
    if (!Number.isSafeInteger(next) || next <= afterSequence) break;
    afterSequence = next;
  }
  throw new Error("The retained chat history could not be completely inspected; do not issue another preparation.");
}

// Manual connected acceptance: a real subscribed Codex agent must discover the
// current WSP capability and preserve its admission boundary across UI reload.
// This scenario never registers a scripted provider or creates synthetic runs.
export default desktopScenario({
  name: "weight-space-live-prepare",
  mode: "attach",
  timeoutMs: 600_000,
  async run(harness) {
    if (harness.launchMode !== "attach") throw new Error("Use the authenticated development Desktop with --attach.");
    // Optional immutable reviewed Prepare input for a protected first-issuance handoff.
    // This is an operator-supplied artifact, never a source checkout or hidden answers.
    const originalPath = process.env.OPENPOND_WSP_ACCEPTANCE_PREPARE_FILE;
    const expectedFileHash = process.env.OPENPOND_WSP_ACCEPTANCE_PREPARE_SHA256;
    if (Boolean(originalPath) !== Boolean(expectedFileHash)) throw new Error("Supply both the reviewed Prepare file and its SHA-256.");
    const originalBytes = originalPath ? await readFile(originalPath) : null;
    const originalFileHash = originalBytes ? createHash("sha256").update(originalBytes).digest("hex") : null;
    if (originalBytes && (originalBytes.byteLength > 64 * 1024 || originalFileHash !== expectedFileHash)) throw new Error("The reviewed Prepare artifact changed.");
    const original = originalBytes ? await parseAndVerifyWeightSpacePrepare(JSON.parse(originalBytes.toString("utf8"))) : null;
    const bootstrap = await harness.api.bootstrap<any>();
    const codex = bootstrap.providers?.statuses?.codex;
    if (!codex?.available || !codex.modelIds.includes("gpt-6.1-sol")) throw new Error("The configured Codex subscription must offer gpt-6.1-sol.");
    const modelRef = { providerId: "codex", modelId: "gpt-6.1-sol" };
    const resumeId = process.env.OPENPOND_WSP_ACCEPTANCE_SESSION_ID;
    const continueId = process.env.OPENPOND_WSP_ACCEPTANCE_CONTINUE_SESSION_ID;
    const requestedTurnId = process.env.OPENPOND_WSP_ACCEPTANCE_TURN_ID;
    // Preparing through the running Desktop server can coexist with another
    // renderer acceptance. Reopening remains a separate required UI witness.
    const serverOnly = process.env.OPENPOND_WSP_ACCEPTANCE_SERVER_ONLY === "1";
    if (serverOnly && !original) throw new Error("Server-only acceptance requires the reviewed original Prepare.");
    if (continueId && (resumeId || !serverOnly)) throw new Error("Continue an existing chat only for a new server-only reviewed preparation.");
    const workingDirectory = resumeId ? null : await mkdtemp(path.join(os.tmpdir(), "openpond-wsp-acceptance-"));
    const prepareFile = originalBytes && workingDirectory ? path.join(workingDirectory, "original-prepare.json") : null;
    const capabilityFile = original && workingDirectory ? path.join(workingDirectory, "capability-query.json") : null;
    if (prepareFile && originalBytes) await writeFile(prepareFile, originalBytes, { flag: "wx" });
    if (capabilityFile && original) await writeFile(capabilityFile, JSON.stringify(original.query, null, 2), { flag: "wx" });
    const session = resumeId || continueId ? { id: (resumeId || continueId)!, title: "WSP preparation acceptance" } : await harness.api.createSession<{ id: string; title: string }>({
      experience: "chat", provider: "codex", modelRef,
      title: harness.uniqueTitle("WSP prepare-only acceptance"),
      cwd: workingDirectory,
    });
    harness.recordMetadata({ sessionId: session.id, modelRef, workingDirectory, liveAgent: true, mockedProvider: false,
      reviewedPrepareFileSha256: originalFileHash, designatedTeacher: original?.request.teacher ?? null,
      preparationIssuer: original ? "desktop_agent_on_behalf_of_designated_teacher" : "desktop_agent",
      rendererReopeningDeferred: serverOnly,
      issuanceExpectation: resumeId ? "retained_original_receipt_recovery" : original ? "first_issuance_owner_confirmed_before_run" : "unprotected_capability_discovery" });
    if (!serverOnly) {
      await reloadRenderer(harness);
      await waitForSidebarSessionRow(harness, session.id);
      await harness.renderer.selectSession(session.id);
    }
    const prompt = original ? `PREPARATION ONLY. Issue the original reviewed weight-space Prepare on behalf of the designated editing teacher. The operation has never been submitted, and its protected grant is already installed. The immutable original input file is ${JSON.stringify(prepareFile)}; its byte SHA-256 is ${originalFileHash}. The capability query file is ${JSON.stringify(capabilityFile)}. Read the installed CLI skill/reference and official help, then use the app's scoped executor and bundled official CLI with its supplied OpenPond home/account. Confirm the selected workspace equals the request teamId; do not switch accounts. Invoke hosted-weight-space-capability with the supplied exact query. Require execution.state ready and its exact model equal the original request model; if unavailable or changed, retain the reason and stop without preparation. Then invoke hosted-prepare-weight-space with that original file exactly once and retain the entire accepted receipt. Do not edit, reserialize or replace this input, operation ID, query, model, panels, frozen Dataset reference, limits, spending bound or declared teacher. The designated editing teacher is ${JSON.stringify(original.request.teacher)}; you are issuing preparation on its behalf, and must not claim to be that teacher or delegate/reassign the teacher identity. This request approves only free preparation, not paid execution. Its reviewed ceiling is $${original.maximumSpendUsd}, duration ${original.request.limits.maximumDurationSeconds}s and idle ${original.request.limits.maximumIdleSeconds}s; those exact bounds belong to the existing claim. Do not start, resume, allocate, edit tensors, evaluate, score, finalize, save a Model, activate serving, create schedules or start another agent. Do not inspect frozen answers or graders. The supplied file and query are user-provided artifacts in this empty working directory; do not inspect application repository sources or change code. Let the successful official CLI operation attach the original execution to this originating chat. Report its execution ID, prepared phase, revision and plan hash, and preserve the separate designated teacher provenance. If projection fails, report it without another Prepare request. Stop after the receipt and attachment; the operator will hand the same execution to its designated teacher afterward.` : "Prepare a weight-space programming experiment using the exact supported dense BF16 Qwen3-8B checkpoint in the current selected OpenPond workspace. Use this local agent as teacher. The objective is to answer simple arithmetic concisely. I explicitly review this development panel: user prompt 'What is 2 + 2? Reply with only the number.' and this preservation panel: user prompt 'What is the capital of France? Reply with only the city.' Fixed greedy generation, seed 0, maximum 16 output tokens per prompt. Proposed remote compute ceiling $1 total, duration 120 seconds and idle timeout 60 seconds. This is PREPARATION ONLY: do not start compute, allocate or resume a worker, execute tensor edits or evaluation, score outputs, activate serving or create any schedule. Resolve the exact base/tokenizer and runtime through the official bundled CLI. If the exact runtime is unavailable, retain its exact reason and stop; do not change the model or claim successful preparation. Attach any genuinely accepted preparation to this chat and report its stable identity; if preparation cannot be accepted, clearly say there is no accepted session. Use the installed OpenPond CLI skill/reference and command help; this empty working directory has no development checkout, so do not inspect application repository source files to discover request fields. Do not implement code or modify repository files.";
    let submittedTurnId: string | undefined;
    if (!resumeId) {
      if (serverOnly) {
        const turn = await harness.api.createTurn<{ id: string }>(session.id, { prompt, modelRef });
        submittedTurnId = turn.id;
        if (!submittedTurnId) throw new Error("The submitted original turn has no identity; recover this chat without another prompt.");
        harness.recordMetadata({ submittedTurnId });
      }
      else await harness.renderer.submitComposer(prompt);
    }
    const exactTurnId = submittedTurnId ?? requestedTurnId;
    // Bootstrap events are only a recent global window. An older retained turn
    // must be recovered from its chat's paginated history, without waiting for
    // a past completion to appear as a new event or submitting another prompt.
    const retained = resumeId ? await retainedSessionEvents(harness, session.id) : null;
    const completed = retained
      ? retained.filter(event => event.sessionId === session.id && event.name === "turn.completed" && (!exactTurnId || event.turnId === exactTurnId)).at(-1)
      : await harness.events.waitFor(event => event.sessionId === session.id && event.name === "turn.completed" && (!exactTurnId || event.turnId === exactTurnId), "live WSP preparation turn", { sessionId: session.id, timeoutMs: 570_000 });
    if (!completed) throw new Error("The original retained turn has no completion event; do not submit another prompt or preparation.");
    harness.recordMetadata({ completedTurnId: completed.turnId });
    if (completed.status !== "completed") throw new Error(`The live WSP turn ended as ${completed.status}.`);
    const events = (retained ?? await retainedSessionEvents(harness, session.id)).filter(event => event.turnId === completed.turnId);
    const tools = events.filter(event => event.name.startsWith("tool.")).map(event => ({ name: event.name, action: event.action, status: event.status, data: event.data, output: event.output }));
    const commandEvidence = tools.filter(event => event.name === "tool.started" || event.name === "tool.requested").map(event => JSON.stringify(event.data)).join("\n");
    if (/\/(?:packages\/[^/]+\/src|apps\/[^/]+\/src|lib\/sandbox)\//.test(commandEvidence)) throw new Error("The installed agent depended on developer source paths.");
    const cliReceipts = tools.flatMap(event => {
      if (event.name !== "tool.completed" || event.data?.tool !== "openpond_exec_command") return [];
      const envelope = event.data?.result?.content?.find((item: any) => item.type === "text");
      if (!envelope) return [];
      const commandResult = JSON.parse(envelope.text);
      if (commandResult?.data?.exitCode !== 0) return [];
      try { return [JSON.parse(commandResult.data.stdout)]; }
      catch { return []; }
    });
    const capability = cliReceipts.filter(value => value.schemaVersion === "openpond.weightSpaceCapability.v1").at(-1);
    if (capability?.schemaVersion !== "openpond.weightSpaceCapability.v1") throw new Error("The actual agent did not obtain a WSP capability receipt through the official CLI.");
    if (/hosted-(?:start-weight-space|control-weight-space-serving|worker-resume|base-serving-prepare)\b/.test(commandEvidence)) throw new Error("The agent attempted compute despite preparation-only scope.");
    const preparation = cliReceipts.find(value => value.schemaVersion === "openpond.weightSpaceExecutionReceipt.v1");
    if (original && /hosted-(?:weight-space-command|save-weight-space-model|cancel-weight-space)\b|experiments\s+score\b/.test(commandEvidence)) throw new Error("The agent attempted a command outside exact preparation scope.");
    if (original && capability.execution.state !== "ready") throw new Error("The exact protected runtime was not ready; first-issuance preparation remains unproved.");
    if (original && await canonicalSha256(capability.query) !== await canonicalSha256(original.query)) throw new Error("Capability query differs from the protected original.");
    if (original && await canonicalSha256(capability.execution.model) !== await canonicalSha256(original.request.model)) throw new Error("The ready model differs from the protected original.");
    if (original && cliReceipts.filter(value => value.schemaVersion === "openpond.weightSpaceExecutionReceipt.v1").length !== 1) throw new Error("Expected exactly one accepted original Prepare receipt.");
    if (original && preparation) {
      await parseAndVerifyWeightSpaceExecutionReceipt(preparation, original);
      // The Prepare receipt contains metadata, not the full request. The SDK
      // verifier above binds plan.inputHash to the complete original request.
      if (prepareFile && createHash("sha256").update(await readFile(prepareFile)).digest("hex") !== originalFileHash) throw new Error("The agent changed the original input file.");
    }
    if (capability.execution.state === "ready" && !preparation) throw new Error("The runtime was ready but the actual agent did not obtain an accepted preparation.");
    if (preparation && preparation.execution.phase !== "prepared") throw new Error("Preparation advanced beyond the prepared state.");
    const transcript = events.filter(event => ["assistant.delta", "assistant.message", "turn.completed"].includes(event.name)).map(event => ({ name: event.name, status: event.status, output: event.output }));
    await mkdir(harness.artifactsDir, { recursive: true });
    await writeFile(path.join(harness.artifactsDir, "live-agent-evidence.json"), JSON.stringify({ sessionId: session.id, modelRef, completedTurnId: completed.turnId, reviewedPrepareFileSha256: originalFileHash, designatedTeacher: original?.request.teacher ?? null, capability, preparation, tools, transcript }, null, 2));
    if (preparation) await writeFile(path.join(harness.artifactsDir, "original-prepare-receipt.json"), JSON.stringify(preparation, null, 2));
    if (!serverOnly) {
      await reloadRenderer(harness);
      await waitForSidebarSessionRow(harness, session.id);
      await harness.renderer.selectSession(session.id);
      await waitForRendererCondition(harness, `document.querySelector('.chat-thread[aria-label="Conversation"]')?.textContent?.includes(${JSON.stringify("PREPARATION ONLY")})`, "persisted preparation-only request");
    }
    if (preparation && !serverOnly) {
      const current = await harness.api.fetchJson<any>("/v1/local-datasets", { method: "POST", body: { action: "context_selection", payload: { sessionId: session.id } } });
      if (current.selection?.target?.kind !== "weight_space_session" || current.selection.target.id !== preparation.execution.id || (!resumeId && current.selection.weightSpace?.phase !== "prepared")) throw new Error("The original accepted editing-session attachment was not retained.");
      await harness.renderer.assertText(preparation.execution.name, { label: "accepted WSP preparation in reopened chat" });
      harness.recordAssertion("acceptedSessionAttachmentReopened", true);
    }
    if (original && preparation) harness.recordAssertion("immutableOriginalPreparationAcceptedInDesktop", true);
    harness.recordAssertion("realAgentCapabilityDiscovery", true);
    harness.recordAssertion("noComputeStartAttempt", true);
    if (!serverOnly) harness.recordAssertion("requestReopenedAfterReload", true);
    harness.recordMetadata({ evidencePath: path.join(harness.artifactsDir, "live-agent-evidence.json"), toolEventCount: tools.length,
      admission: capability.execution, acceptedPreparationProven: Boolean(preparation), acceptedSessionAttachmentProven: Boolean(preparation) && !serverOnly,
      rendererReopeningProven: !serverOnly });
    if (!serverOnly) await harness.screenshot("weight-space-live-preparation-reopened");
  },
});
