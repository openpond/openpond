import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256 } from "@openpond/harness";

type AgentRuntime = {source:string;cliRelativePath:string};
const cliRelativePath="node_modules/openpond-agent-sdk/dist/cli.js";

/** Install only the server's public SDK archive and its declared dependencies.
 * Candidate commands receive this dedicated read-only tree, never the server's
 * repository, module cache, account credentials or installation environment. */
export function createCandidateAgentRuntimeLoader(deps:{storeDir:string;loadArchive():Promise<Buffer>}) {
  let pending:Promise<AgentRuntime>|null=null;
  return async()=>{
    pending??=stage();
    try{return await pending;}catch(error){pending=null;throw error;}
  };

  async function stage():Promise<AgentRuntime>{
    const archive=await deps.loadArchive(),hash=sha256(archive);
    const parent=path.join(deps.storeDir,"library","harnesses","candidate-agent-runtime"),destination=path.join(parent,hash);
    await fs.mkdir(parent,{recursive:true,mode:0o700});
    const existing=await readReady(destination,hash);
    if(existing)return existing;
    const temporary=await fs.mkdtemp(path.join(parent,`.install-${hash.slice(0,12)}-`));
    try{
      await fs.chmod(temporary,0o700);
      const archivePath=path.join(temporary,"sdk.tgz");
      await fs.writeFile(archivePath,archive,{mode:0o600});
      await fs.writeFile(path.join(temporary,"package.json"),JSON.stringify({name:"openpond-candidate-agent-runtime",private:true,type:"module"}),{mode:0o600});
      await installPublicArchive(temporary);
      await validateCli(temporary);
      await fs.rm(archivePath);
      await fs.rm(path.join(temporary,".npm-cache"),{recursive:true,force:true});
      await fs.rm(path.join(temporary,".installation-home"),{recursive:true,force:true});
      await fs.writeFile(path.join(temporary,"ready.json"),JSON.stringify({archiveHash:hash,cliRelativePath}),{mode:0o400});
      try{await fs.rename(temporary,destination);}catch(error){
        const retained=await readReady(destination,hash);
        if(!retained)throw error;
        return retained;
      }
      return {source:destination,cliRelativePath};
    }finally{await fs.rm(temporary,{recursive:true,force:true});}
  }
}

async function readReady(root:string,archiveHash:string):Promise<AgentRuntime|null>{
  const bytes=await fs.readFile(path.join(root,"ready.json"),"utf8").catch(error=>{if(error.code==="ENOENT")return null;throw error;});
  if(bytes===null)return null;
  const receipt=JSON.parse(bytes) as {archiveHash?:unknown;cliRelativePath?:unknown};
  if(receipt.archiveHash!==archiveHash||receipt.cliRelativePath!==cliRelativePath)throw new Error("The confined Agent runtime archive changed.");
  await validateCli(root);
  return {source:root,cliRelativePath};
}

async function validateCli(root:string){
  const actualRoot=await fs.realpath(root),cli=await fs.realpath(path.join(root,cliRelativePath));
  if(!cli.startsWith(`${actualRoot}${path.sep}`)||(await fs.stat(cli)).isFile()!==true)throw new Error("The public Agent runtime CLI escapes its installed package.");
  const pkg=JSON.parse(await fs.readFile(path.join(root,"node_modules","openpond-agent-sdk","package.json"),"utf8")) as {name?:unknown;bin?:Record<string,unknown>};
  if(pkg.name!=="openpond-agent-sdk"||pkg.bin?.["openpond-agent"]!=="dist/cli.js")throw new Error("The installed package is not the server's public Agent SDK.");
}

async function installPublicArchive(root:string):Promise<void>{
  const home=path.join(root,".installation-home");await fs.mkdir(home,{mode:0o700});
  const userConfig=path.join(home,"user.npmrc"),globalConfig=path.join(home,"global.npmrc");
  await Promise.all([fs.writeFile(userConfig,"",{mode:0o600}),fs.writeFile(globalConfig,"",{mode:0o600})]);
  return new Promise((resolve,reject)=>{
    const windows=process.platform==="win32";
    const child=spawn(windows?"npm.cmd":"npm",["install","--ignore-scripts","--no-audit","--no-fund","--no-package-lock","--save-exact","./sdk.tgz"],{
      cwd:root,detached:!windows,stdio:["ignore","pipe","pipe"],
      env:{PATH:process.env.PATH??"/usr/bin:/bin",HOME:home,TMPDIR:home,
        npm_config_cache:path.join(root,".npm-cache"),npm_config_userconfig:userConfig,npm_config_globalconfig:globalConfig,
        npm_config_registry:"https://registry.npmjs.org",npm_config_ignore_scripts:"true",...(windows&&process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},
    });
    let diagnostics="",settled=false;
    const capture=(bytes:Buffer)=>{if(diagnostics.length<8000)diagnostics+=bytes.toString("utf8").slice(0,8000-diagnostics.length);};
    child.stdout.on("data",capture);child.stderr.on("data",capture);
    const timer=setTimeout(()=>{try{if(child.pid&&!windows)process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}catch{child.kill("SIGKILL");}},120_000);
    child.once("error",error=>{clearTimeout(timer);if(!settled){settled=true;reject(error);}});
    child.once("close",code=>{clearTimeout(timer);if(settled)return;settled=true;if(code===0)resolve();else reject(new Error(`The dependency-complete public Agent runtime could not be installed (${code??"timeout"}): ${diagnostics}`));});
  });
}
