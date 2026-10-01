import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { createCandidateCommandExecutor } from "../harness/experiment-candidate-command.js";
// Failure story: local model commands must not read private holdout/credentials,
// write input fixtures, reach host networking or survive cancellation. This runs
// the actual kernel confinement, not a mocked child process or string assertion.
test("advanced Work layout confines real file/network/process access and current owner", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "advanced-work-boundary-")),
    root = path.join(home, "workspace"),
    privateFile = path.join(home, "private-holdout.json");
  await Promise.all([
    mkdir(path.join(root, "work"), { recursive: true }),
    mkdir(path.join(root, "inputs"), { recursive: true }),
    mkdir(path.join(root, "outputs"), { recursive: true }),
  ]);
  await writeFile(privateFile, "PRIVATE_HOLDOUT_CANARY");
  await writeFile(path.join(root, "inputs", "case.txt"), "public input");
  const server = createServer((_, response) =>
    response.end("unexpected network access"),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  let authorized = true;
  const execute = createCandidateCommandExecutor({
      authorize: async () => {
        if (!authorized) throw new Error("The actual owner changed");
        return {
          candidateId: "real-fixture",
          candidateRevision: 1,
          ownerId: "actual-actor",
          sessionId: "work-case",
          turnId: "turn-case",
          sourceRoot: root,
          layout: "work",
          writablePaths: ["work", "outputs"],
        };
      },
    }),
    base = {
      candidateId: "real-fixture",
      sessionId: "work-case",
      turnId: "turn-case",
      expectedRevision: 1,
    };
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  try {
    const program = `const fs=require('node:fs'),net=require('node:net');let privateRead=false,inputWrite=false;try{fs.readFileSync(${JSON.stringify(privateFile)});privateRead=true}catch{}try{fs.writeFileSync('/workspace/inputs/case.txt','mutated');inputWrite=true}catch{}fs.symlinkSync(${JSON.stringify(privateFile)},'/workspace/work/leak');let symlinkRead=false;try{fs.readFileSync('/workspace/work/leak');symlinkRead=true}catch{}const connection=net.connect(${port},'127.0.0.1');connection.once('connect',()=>{process.stdout.write(JSON.stringify({privateRead,inputWrite,symlinkRead,network:true}));connection.end()});connection.once('error',()=>process.stdout.write(JSON.stringify({privateRead,inputWrite,symlinkRead,network:false,home:process.env.HOME,cwd:process.cwd()})));`;
    const result = await execute({
      ...base,
      command: `/runtime/node -e ${quote(program)}`,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      privateRead: false,
      inputWrite: false,
      symlinkRead: false,
      network: false,
      home: "/tmp/home",
      cwd: "/workspace/work",
    });
    expect(await readFile(path.join(root, "inputs", "case.txt"), "utf8")).toBe(
      "public input",
    );
    const controller = new AbortController(),
      running = execute({
        ...base,
        command:
          '/runtime/node -e \'setInterval(()=>require("node:fs").appendFileSync("/workspace/work/ticks","x"),20)\'',
        signal: controller.signal,
      });
    for(let attempt=0;attempt<100;attempt++) {
      try { if((await readFile(path.join(root,"work","ticks"),"utf8")).length)break; } catch {}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    controller.abort(new Error("Owner cancelled"));
    await expect(running).rejects.toThrow("Owner cancelled");
    const before = await readFile(path.join(root, "work", "ticks"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(path.join(root, "work", "ticks"), "utf8")).toBe(
      before,
    );
    authorized = false;
    await expect(execute({ ...base, command: "true" })).rejects.toThrow(
      "owner changed",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
