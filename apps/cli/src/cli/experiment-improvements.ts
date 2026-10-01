import {ExperimentImprovementClient, ExperimentImprovementCommandSchema} from "openpond-sdk/experiment-improvements";
import {optionString} from "./common";
import {evaluationCommandAccess, readEvaluationCommandInput} from "./evaluation-command-access";

export async function runExperimentImprovementsCommand(options:Record<string,string|boolean>, rest:string[]) {
  const [action,id] = rest, actorId = optionString(options,"actor");
  if (!actorId || !action || rest.length > 2)
    throw new Error("usage: improve <list|read|instructions|request> [id] --team <id> --actor <owner-id> [--input-file <path>] [--local --server-url <loopback-origin>]");
  const request = ExperimentImprovementCommandSchema.parse(action === "request"
    ? await readEvaluationCommandInput(options)
    : action === "list" ? {operation:action,limit:Number(optionString(options,"limit") || 30),...(optionString(options,"cursor") ? {cursor:optionString(options,"cursor")} : {})}
    : {operation:action,id});
  if (action === "request" && id || action === "list" && id) throw new Error("This operation does not accept a candidate id.");
  const client = new ExperimentImprovementClient({...await evaluationCommandAccess(options),actorId});
  console.log(JSON.stringify(await client.command(request,AbortSignal.timeout(60_000)),null,2));
}
