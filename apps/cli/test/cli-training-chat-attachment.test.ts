import { afterEach, expect, test, vi } from "vitest";
import { TrainingApiClient } from "../src/cli/training";

afterEach(()=>vi.unstubAllEnvs());

// Attachment is a recoverable projection: its failure must not mask an admitted
// paid job or cause the command to repeat the training submission.
test("training keeps the admitted job when chat attachment fails and standalone calls do not attach", async()=>{
  vi.stubEnv("OPENPOND_CHAT_INVOCATION","scoped-invocation");
  const saved = {job:{id:"saved-job",metadata:{modelRunId:"saved-run"}}};
  const requests: Array<{url:string;body:unknown}> = [];
  const request = vi.fn<typeof fetch>(async(url,init)=>{
    requests.push({url:String(url),body:init?.body ? JSON.parse(String(init.body)) : null});
    return String(url).endsWith("/v1/chat-experiments")
      ? new Response(JSON.stringify({error:"temporary attachment failure"}),{status:503})
      : new Response(JSON.stringify(saved),{status:200});
  });
  const warning = vi.spyOn(console,"error").mockImplementation(()=>{});
  const client = new TrainingApiClient({baseUrl:"http://localhost:17874",request});
  expect(await client.startModelProject("model",{approvalId:"approved"})).toEqual(saved);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.body).toEqual({action:"attach_training",payload:{jobId:"saved-job"},invocationToken:"scoped-invocation"});
  expect(warning).toHaveBeenCalledOnce();
  vi.stubEnv("OPENPOND_CHAT_INVOCATION","");
  await client.modelRun("saved-run","status","GET");
  expect(requests).toHaveLength(3);
});
