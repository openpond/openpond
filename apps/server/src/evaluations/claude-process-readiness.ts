import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {access,mkdtemp,realpath,rm,stat} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {tmpdir} from "node:os";
import {contentHash} from "@openpond/harness";
export const CLAUDE_REQUIRED_FLAGS=["--bare","--input-format","--output-format","--include-partial-messages","--session-id","--tools","--disallowedTools","--permission-mode","--max-budget-usd","--max-turns","--strict-mcp-config","--mcp-config"];
export async function readClaudeExecutable(){
 if(process.platform==="win32")return{ready:false as const,reason:"Live Claude execution requires the supported POSIX process-group owner. Native Windows needs a qualified Job Object owner before Start; use a supported Linux/macOS runtime."};
 let executable:string|undefined;
 for(const directory of (process.env.PATH??"").split(path.delimiter)){if(!directory||!path.isAbsolute(directory))continue;try{const candidate=await realpath(path.join(directory,"claude"));await access(candidate,constants.X_OK);if((await stat(candidate)).isFile()){executable=candidate;break;}}catch{}}
 if(!executable)return{ready:false as const,reason:"Install a supported Claude Code 2.1.217+ executable on PATH and connect an Anthropic API-key provider in Settings."};
 try{const versionText=await probe(executable,["--version"]),version=/\b(2\.\d+\.\d+)\b/.exec(versionText)?.[1];if(!version||Number(version.split(".")[1])<1||Number(version.split(".")[1])===1&&Number(version.split(".")[2])<217)throw new Error("Claude Code 2.1.217 or newer is required for nested-agent budget enforcement.");const help=await probe(executable,["--help"]);if(CLAUDE_REQUIRED_FLAGS.some(flag=>flag!=="--max-turns"&&!help.includes(flag)))throw new Error("The installed Claude interface lacks required isolated streaming/session/budget flags.");if(!help.includes("--max-turns"))await probeHiddenTurnLimit(executable);const hash=createHash("sha256");let bytes=0;for await(const chunk of createReadStream(executable)){bytes+=chunk.length;if(bytes>536870912)throw new Error("Claude executable exceeds its admitted binary size.");hash.update(chunk);}return{ready:true as const,executable,version,executableHash:hash.digest("hex"),capabilityHash:contentHash({flags:CLAUDE_REQUIRED_FLAGS,version,tools:[],isolation:"bare-no-tools-no-mcp",processOwner:"posix-process-group"})};}catch(error){return{ready:false as const,reason:error instanceof Error?error.message:"Claude readiness probe failed."};}
}
// Recent CLIs hide --max-turns from help. Check argument parsing with no prompt,
// credentials or inherited configuration; a successful model call is impossible.
async function probeHiddenTurnLimit(executable:string){
 const directory=await mkdtemp(path.join(tmpdir(),"openpond-claude-readiness-"));
 try{await new Promise<void>((resolve,reject)=>{
  const child=spawn(executable,["--bare","-p","--max-turns","1"],{cwd:directory,env:{PATH:process.env.PATH??"",HOME:directory,CLAUDE_CONFIG_DIR:directory,DISABLE_AUTOUPDATER:"1"},stdio:["ignore","pipe","pipe"],shell:false,windowsHide:true});let output="",bytes=0;
  const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Claude turn-limit capability probe timed out."));},5000);
  for(const stream of [child.stdout,child.stderr]){stream.setEncoding("utf8");stream.on("data",(chunk:string)=>{bytes+=Buffer.byteLength(chunk);if(bytes>262144){child.kill("SIGKILL");reject(new Error("Claude turn-limit capability output exceeds its limit."));}else output+=chunk;});}
  child.once("error",error=>{clearTimeout(timer);reject(error);});child.once("close",code=>{clearTimeout(timer);if(code===1&&/Input must be provided either through stdin or as a prompt argument when using --print/.test(output)&&!/unknown option/i.test(output))resolve();else reject(new Error("The installed Claude interface does not demonstrate turn-limit argument support."));});
 });}finally{await rm(directory,{recursive:true,force:true});}
}
function probe(executable:string,args:string[]):Promise<string>{return new Promise((resolve,reject)=>{const child=spawn(executable,args,{stdio:["ignore","pipe","pipe"],shell:false,windowsHide:true});let output="",bytes=0;const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Claude readiness probe timed out."));},5000);child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");for(const stream of [child.stdout,child.stderr])stream.on("data",(chunk:string)=>{bytes+=Buffer.byteLength(chunk);if(bytes>262144){child.kill("SIGKILL");reject(new Error("Claude readiness output exceeds its limit."));}else output+=chunk;});child.once("error",reject);child.once("close",code=>{clearTimeout(timer);if(code!==0)reject(new Error("Claude readiness probe did not succeed."));else resolve(output);});});}
