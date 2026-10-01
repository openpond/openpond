import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Session } from "@openpond/contracts";
import { createCandidateCommandExecutor } from "../harness/experiment-candidate-command.js";
import { currentAdvancedRefinerBoundary } from "./advanced-refiner-paid-boundary.js";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
// Runs inside the actual PID/mount/network namespace. Host file tools never
// follow model-created symlinks; all returned bytes come from a sealed export.
const fileProgram = String.raw`const fs=require('node:fs'),p=require('node:path');let raw='';process.stdin.on('data',v=>raw+=v);process.stdin.on('end',()=>{try{const i=JSON.parse(raw),root='/workspace';const target=p.resolve(root,String(i.args.path||'').replace(/^\/workspace\//,''));if(target!==root&&!target.startsWith(root+'/'))throw Error('Work path escapes its admitted root');const a=i.action;let result={};if(a==='sandbox_list_files'){const files=[];const walk=t=>{for(const entry of fs.readdirSync(t,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const n=p.join(t,entry.name);files.push(p.relative(root,n));if(i.args.recursive&&entry.isDirectory())walk(n);if(files.length>=1000)return;}};const s=fs.lstatSync(target);if(s.isDirectory())walk(target);else files.push(p.relative(root,target));result={files};}else if(a==='sandbox_read_file'||a==='sandbox_save_output'){const bytes=fs.readFileSync(target);if(bytes.length>i.maxBytes)throw Error('Work file exceeds its bounded output size');const exportPath=p.join(root,'.evaluation-exports',i.exportName);fs.writeFileSync(exportPath,bytes,{flag:'wx',mode:384});result={exportName:i.exportName,sizeBytes:bytes.length};}else if(a==='sandbox_write_file'||a==='sandbox_edit_file'){let contents=String(i.args.contents||'');if(a==='sandbox_edit_file'){contents=fs.readFileSync(target,'utf8');if(!contents.includes(String(i.args.oldText)))throw Error('The exact text to replace was not found');contents=i.args.replaceAll?contents.replaceAll(String(i.args.oldText),String(i.args.newText)):contents.replace(String(i.args.oldText),String(i.args.newText));}fs.mkdirSync(p.dirname(target),{recursive:true});fs.writeFileSync(target,contents);result={path:p.relative(root,target),sizeBytes:Buffer.byteLength(contents)};}else if(a==='sandbox_delete_file'){fs.rmSync(target,{recursive:i.args.recursive===true,force:true});result={path:p.relative(root,target)};}else throw Error('Unsupported confined file operation');process.stdout.write(JSON.stringify(result));}catch(e){process.stderr.write(e.message);process.exitCode=1;}});`;
export function createAdvancedLocalWorkTools() {
  const queues = new Map<string, Promise<unknown>>();
  return async (input: {
    session: Session;
    root: string;
    turnId: string | null;
    action: string;
    args: Record<string, unknown>;
    maximumBytes: number;
  }) => {
    const guard = currentAdvancedRefinerBoundary();
    if (!guard) throw new Error("The advanced Work admission is unavailable.");
    const previous = queues.get(input.root) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        await guard.authorize();
        guard.signal.throwIfAborted();
        if (input.session.metadata?.parentModelRunId !== guard.runId)
          throw new Error(
            "The Work session differs from its actual admitted evaluation Run.",
          );
        const exporting =
            input.action === "sandbox_read_file" ||
            input.action === "sandbox_save_output",
          exportName = randomUUID();
        await fs.mkdir(path.join(input.root, ".evaluation-exports"), {
          recursive: true,
          mode: 0o700,
        });
        const execute = createCandidateCommandExecutor({
          authorize: async () => {
            await guard.authorize();
            guard.signal.throwIfAborted();
            return {
              candidateId: guard.runId,
              candidateRevision: 0,
              ownerId: guard.pin.actorId,
              sessionId: input.session.id,
              turnId: input.turnId ?? "environment",
              sourceRoot: input.root,
              layout: "work",
              writablePaths: exporting
                ? [".evaluation-exports"]
                : ["work", "outputs"],
            };
          },
        });
        const result = await execute({
          candidateId: guard.runId,
          sessionId: input.session.id,
          turnId: input.turnId ?? "environment",
          expectedRevision: 0,
          signal: guard.signal,
          command:
            input.action === "sandbox_exec"
              ? String(input.args.command)
              : `/runtime/node -e ${quote(fileProgram)}`,
          stdin:
            input.action === "sandbox_exec"
              ? undefined
              : JSON.stringify({
                  ...input,
                  session: undefined,
                  root: undefined,
                  exportName,
                  maxBytes: input.maximumBytes,
                }),
          timeoutMs:
            input.action === "sandbox_exec"
              ? Math.min(
                  Number(input.args.timeoutSeconds ?? 120) * 1000,
                  180000,
                )
              : 30000,
          maxOutputBytes: 1000000,
        });
        await guard.authorize();
        guard.signal.throwIfAborted();
        if (
          result.code !== 0 ||
          result.timedOut ||
          result.stdoutTruncated ||
          result.stderrTruncated
        )
          throw new Error(
            result.stderr ||
              "The confined Work operation failed or exceeded its bounds.",
          );
        if (input.action === "sandbox_exec")
          return {
            data: {
              exitCode: result.code,
              stdout: result.stdout,
              stderr: result.stderr,
            },
            bytes: null,
          };
        const data = JSON.parse(result.stdout) as Record<string, unknown>;
        let bytes: Buffer | null = null;
        if (exporting) {
          if (data.exportName !== exportName)
            throw new Error("The sealed Work output receipt changed.");
          const sealed = path.join(
            input.root,
            ".evaluation-exports",
            exportName,
          );
          try {
            bytes = await fs.readFile(sealed);
            if (
              bytes.length !== data.sizeBytes ||
              bytes.length > input.maximumBytes
            )
              throw new Error(
                "The sealed Work output exceeds its admitted bytes.",
              );
          } finally {
            await fs.rm(sealed, { force: true });
          }
        }
        return { data, bytes };
      });
    queues.set(input.root, task);
    try {
      return await task;
    } finally {
      if (queues.get(input.root) === task) queues.delete(input.root);
    }
  };
}
