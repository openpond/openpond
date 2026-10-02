import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { contentHash } from "@openpond/harness";
import { CollectorStore } from "./collector-store.js";
import type { CollectorConnection } from "./collector-contracts.js";
const execute=promisify(execFile);
const command=async(file:string,args:string[])=>{await execute(file,args,{timeout:15000,maxBuffer:16384,windowsHide:true});};
const xml=(value:string)=>value.replace(/&/gu,"&amp;").replace(/</gu,"&lt;").replace(/>/gu,"&gt;").replace(/"/gu,"&quot;");
const systemd=(value:string)=>`"${value.replace(/\\/gu,"\\\\").replace(/"/gu,'\\"').replace(/%/gu,"%%").replace(/\$/gu,"$$")}"`;
export interface CollectorServiceSetup { directory:string; executable:string; args:string[]; home?:string }
function identity(directory:string){return `openpond-import-${contentHash(directory).slice(0,16)}`;}
export async function configureCollector(directory:string,connection:CollectorConnection){const store=await CollectorStore.open(directory);try{store.put(connection);}finally{store.close();}}
export async function collectorStatus(directory:string){const store=await CollectorStore.open(directory);try{return store.status();}finally{store.close();}}
export async function controlCollector(directory:string,action:"start"|"stop"|"sync"|"pause"|"resume"|"disconnect",connectionId?:string){
  const store=await CollectorStore.open(directory);
  try{
    if(action==="start"||action==="stop")store.set("desiredState",action==="start"?"running":"stopped");
    else if(action==="sync")store.set("syncNow","yes");
    else{const connection=store.connections().find(item=>item.id===connectionId);if(!connection)throw new Error("Select a retained connection.");store.put({...connection,state:action==="pause"?"paused":action==="resume"?"active":"disconnected"});}
    return store.status();
  }finally{store.close();}
}
/** Per-user logon supervision. Installing does not override the retained Stop intent. */
export async function installCollectorService(input:CollectorServiceSetup){
  if(!isAbsolute(input.directory)||!isAbsolute(input.executable)||[input.directory,input.executable,...input.args].some(value=>/[\r\n\0]/u.test(value)))throw new Error("Collector service requires absolute paths and single-line arguments.");
  const home=input.home??homedir(),name=identity(input.directory);
  const launch=[...input.args,"import","service","run","--collector-dir",input.directory];
  if(process.platform==="linux"){
    const directory=join(home,".config/systemd/user");await mkdir(directory,{recursive:true,mode:0o700});
    await writeFile(join(directory,`${name}.service`),`[Unit]\nDescription=OpenPond conversation importer\nAfter=network-online.target\n[Service]\nType=simple\nExecStart=${[input.executable,...launch].map(systemd).join(" ")}\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\n[Install]\nWantedBy=default.target\n`,{mode:0o600});
    await command("systemctl",["--user","daemon-reload"]);await command("systemctl",["--user","enable",`${name}.service`]);
  }else if(process.platform==="darwin"){
    const directory=join(home,"Library/LaunchAgents");await mkdir(directory,{recursive:true,mode:0o700});
    const file=join(directory,`${name}.plist`);
    await writeFile(file,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${[input.executable,...launch].map(value=>`<string>${xml(value)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer></dict></plist>`,{mode:0o600});
    await command("launchctl",["bootstrap",`gui/${process.getuid!()}`,file]);
  }else if(process.platform==="win32"){
    const user=(await execute("whoami",[],{timeout:5000,maxBuffer:1024})).stdout.trim();
    const file=join(input.directory,"scheduled-task.xml");await mkdir(input.directory,{recursive:true});
    const quoted=(value:string)=>`"${value.replace(/(\\*)"/gu,'$1$1\\"').replace(/(\\+)$/u,'$1$1')}"`;
    await writeFile(file,`<?xml version="1.0"?><Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Owner"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings><Actions Context="Owner"><Exec><Command>${xml(input.executable)}</Command><Arguments>${xml(launch.map(quoted).join(" "))}</Arguments></Exec></Actions></Task>`,{mode:0o600});
    await command("schtasks",["/Create","/TN",name,"/XML",file,"/F"]);
  }else throw new Error("This OS has no qualified per-user supervisor. Run the collector in the foreground.");
  return{name,platform:process.platform,status:await collectorStatus(input.directory)};
}
export async function startCollectorService(directory:string){
  await controlCollector(directory,"start");const name=identity(directory);
  try{
    if(process.platform==="linux")await command("systemctl",["--user","start",`${name}.service`]);
    else if(process.platform==="darwin")await command("launchctl",["kickstart",`gui/${process.getuid!()}/${name}`]);
    else if(process.platform==="win32")await command("schtasks",["/Run","/TN",name]);
    else throw new Error("No per-user supervisor is available.");
  }catch(error){await controlCollector(directory,"stop");throw error;}
  return collectorStatus(directory);
}
