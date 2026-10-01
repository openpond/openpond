import {promises as fs} from "node:fs";
import path from "node:path";
import {z} from "zod";
import {runHostedExperimentImprovementOwner} from "./harness/hosted-experiment-improvement-owner.js";
/** Only a bounded relative private request file is passed through argv. No
 * Profile/Dataset bytes, tokens, or model credentials enter process arguments. */
export async function runHostedExperimentImprovementCli(args:string[]){
 if(args.length!==1||args[0]!.length>16000||!/^[A-Za-z0-9_-]+$/.test(args[0]!))throw new Error("Hosted Improve IPC argument is invalid.");
 const value=z.object({directory:z.string(),file:z.string().regex(/^[A-Za-z0-9_-]+\.json$/)}).strict().parse(JSON.parse(Buffer.from(args[0]!,"base64url").toString("utf8")));
 if(!path.isAbsolute(value.directory))throw new Error("Hosted Improve IPC requires an absolute private directory.");
 const file=path.join(value.directory,value.file),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024)throw new Error("Hosted Improve private request exceeds its byte/type limit.");
 const cancellation=new AbortController(),stop=()=>cancellation.abort(new Error("The actual hosted owner stopped this private operation."));process.once("SIGTERM",stop);process.once("SIGINT",stop);
 try{const result=await runHostedExperimentImprovementOwner(JSON.parse(await fs.readFile(file,"utf8")),cancellation.signal),bytes=Buffer.from(JSON.stringify(result));if(bytes.length>32*1024*1024)throw new Error("Hosted Improve private response exceeds its byte limit.");process.stdout.write(`${bytes.toString("utf8")}\n`);}finally{process.removeListener("SIGTERM",stop);process.removeListener("SIGINT",stop);}
}
