import { expect, test, vi } from "vitest";
import { createTurnRunnerTestHarness, turnRunnerTestSession } from "./helpers/turn-runner-test-harness";
import { loadBundledAuthoringSkills, readBundledAuthoringProfileSkill } from "../apps/server/src/runtime/bundled-authoring-skills";

// Failure story: a plain local resource chat must admit Codex and expose the
// maintained CLI package without requiring an unrelated coding project.
test.each(["chat", "work"] as const)("ordinary local Codex %s sessions can read the bundled CLI skill through the native bridge", async (experience) => {
  const session=turnRunnerTestSession({provider:"codex",modelRef:{providerId:"codex",modelId:"gpt-6.1-sol"},experience,cwd:"/tmp/openpond",workspaceKind:undefined});
  let read=false;
  const harness=createTurnRunnerTestHarness({sessions:[session],dependencies:{
    executeChatResourceAction:async()=>({}),loadBuiltInOpenPondSkills:loadBundledAuthoringSkills,readBuiltInOpenPondSkill:readBundledAuthoringProfileSkill,
    executeOpenPondCommand:async()=>{throw new Error("No shell command expected during skill read.");},
    ensureCodexRuntime:async (_session,input)=>({threadId:"native-thread",cwd:session.cwd,permissionMode:"default",reasoningEffort:null,
      client:{startTurn:async()=>{
        expect(input.coordination?.tools.some(tool=>tool.name==="openpond_exec_command")).toBe(true);
        const result=await input.coordination!.execute("profile_skill_read",{name:"openpond-cli"},"read-cli",new AbortController().signal) as {content:{text:string}[]};
        const skill=JSON.parse(result.content[0]!.text).data.skill;
        expect(skill.name).toBe("openpond-cli");expect(skill.sourceHash).toMatch(/^[a-f0-9]{64}$/);
        expect(skill.resourceFiles).toContain("references/experiments-and-training.md");read=true;
        return {turnId:"native-turn"};
      },waitForTurn:async()=>{},stopAndWait:async()=>{}} as never}),
  }});
  try {const turn=await harness.runner.sendTurn(session.id,{prompt:"List my datasets.",modelRef:session.modelRef});expect(turn.error).toBeNull();expect(turn.status).toBe("completed");expect(read).toBe(true);}
  finally {await harness.runner.close();}
});

// Failure story: cancellation must not hide an unconfirmed native shutdown or
// preserve output bytes while their producer can still be writing them.
test("unconfirmed native cancellation fails instead of acknowledging clean interruption", async () => {
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const session = turnRunnerTestSession({ provider: "codex", modelRef: { providerId: "codex", modelId: "gpt-6.1-sol" },
    experience: "work", cwd: "/tmp/openpond", workspaceKind: "local_project", workspaceId: "test-project" });
  const stop = vi.fn(async () => { throw new Error("native closure unconfirmed"); });
  const finalize = vi.fn(async () => session);
  const flush = vi.fn(async () => {});
  const harness = createTurnRunnerTestHarness({ sessions: [session], dependencies: {
    ensureCodexRuntime: async () => ({ threadId: "native-thread", cwd: session.cwd, permissionMode: "default", reasoningEffort: null,
      client: { startTurn: async () => ({ turnId: "native-turn" }), interruptTurn: async () => ({}),
        waitForTurn: () => { started(); return new Promise(() => {}); }, stopAndWait: stop } as never }),
    stopCodexRuntime: stop, flushCodexRuntimeEvents: flush, finalizeWorkTurn: finalize,
  } });
  try {
    const pending = harness.runner.sendTurn(session.id, { prompt: "Complete the work.", modelRef: session.modelRef });
    await Promise.race([waiting, pending.then(turn => { throw new Error("Native test failed before waiting: " + turn.error); })]);
    await harness.runner.interruptSessionTurn(session.id);
    const terminal = await pending;
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toContain("native closure unconfirmed");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
  } finally { await harness.runner.close(); }
});
