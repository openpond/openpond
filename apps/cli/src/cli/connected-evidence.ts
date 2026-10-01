import {z} from "zod";
import {ConnectedEvidenceClient} from "openpond-sdk/connected-evidence";
import {optionString} from "./common";
import {evaluationCommandAccess,readEvaluationCommandInput} from "./evaluation-command-access";

/** Each command delegates to the same bounded, identity-checking SDK owner
 * used by the app. Capture/publication and scoring never silently run targets. */
export async function runConnectedEvidenceCommand(options:Record<string,string|boolean>,rest:string[]) {
  const [action,id] = rest;
  if (!action || rest.length > 2) throw new Error("usage: connected-evidence <list|collection|recorded-list|recorded|import-receipt|summary|case|unmapped|capture|selection|publish|prepare-recorded|upload-part|preview|commit|set-collection> [id] --team <id> [--input-file <path>]");
  if (optionString(options,"project") && !["list","recorded-list"].includes(action))
    throw new Error("--project filters list commands; other operations retain their exact Project in --input-file.");
  if (options.local === true || options.local === "true") throw new Error("Connected evidence is retained by its hosted source owner; select --api-base-url for that owner.");
  if (id && !["recorded","import-receipt"].includes(action)) throw new Error("This operation does not accept a resource id.");
  const client = new ConnectedEvidenceClient(await evaluationCommandAccess(options)),signal=AbortSignal.timeout(60_000);
  const page = {...(optionString(options,"project")?{projectId:optionString(options,"project")}:{}),
    ...(optionString(options,"cursor")?{cursor:optionString(options,"cursor")}:{}),limit:Number(optionString(options,"limit")||20)};
  const input = async () => readEvaluationCommandInput(options);
  let result:unknown;
  switch(action) {
    case "list": result=await client.list(page,signal);break;
    case "recorded-list": result=await client.listRecordedExecutions(page,signal);break;
    case "collection": result=await client.collection(signal);break;
    case "recorded": if(!id)throw new Error("Select a recorded execution id.");result=await client.recordedExecution(id,signal);break;
    case "import-receipt": if(!id)throw new Error("Select the original import operation id.");result=await client.readImport(id,signal);break;
    case "summary": result=await client.homeSummary(await input() as Parameters<typeof client.homeSummary>[0],signal);break;
    case "case": result=await client.read(await input() as Parameters<typeof client.read>[0],signal);break;
    case "unmapped": result=await client.unmappedEvents(await input() as Parameters<typeof client.unmappedEvents>[0],signal);break;
    case "capture": result=await client.capture(await input() as Parameters<typeof client.capture>[0],signal);break;
    case "selection": result=await client.createSelection(await input() as Parameters<typeof client.createSelection>[0],signal);break;
    case "publish": result=await client.publishDataset(await input() as Parameters<typeof client.publishDataset>[0],signal);break;
    case "prepare-recorded": result=await client.prepareRecorded(await input() as Parameters<typeof client.prepareRecorded>[0],signal);break;
    case "upload-part": result=await client.uploadPart(await input() as Parameters<typeof client.uploadPart>[0],signal);break;
    case "preview": result=await client.preview(await input() as Parameters<typeof client.preview>[0],signal);break;
    case "commit": result=await client.commit(await input() as Parameters<typeof client.commit>[0],signal);break;
    case "set-collection": result=await client.setCollection(z.object({paused:z.boolean()}).strict().parse(await input()).paused,signal);break;
    default: throw new Error("Unknown connected evidence operation.");
  }
  console.log(JSON.stringify(result,null,2));
}
