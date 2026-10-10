import {expect,test,vi} from "vitest";
import {DesktopBrowserControlWorker} from "../apps/desktop/src/desktop-browser-control-worker.js";

vi.mock("../apps/desktop/src/desktop-html-preview.js",()=>({captureHtmlVisual:vi.fn()}));
vi.mock("../apps/desktop/src/desktop-browser-ipc.js",()=>({browserSidebarManagerForWindow:vi.fn()}));

// A stalled request during server reload must expire and register the preview
// worker again; otherwise every subsequent HTML result remains unavailable.
test("desktop preview worker recovers from a stalled registration and stops polling on shutdown",async()=>{
  const deadlines:AbortController[]=[];
  const timeout=vi.spyOn(AbortSignal,"timeout").mockImplementation(milliseconds=>{
    expect(milliseconds).toBe(35_000);
    const controller=new AbortController();deadlines.push(controller);return controller.signal;
  });
  const paths:string[]=[];
  const fetch=vi.spyOn(globalThis,"fetch").mockImplementation(async(url,init)=>{
    paths.push(String(url));
    if(paths.length===2)return new Response(JSON.stringify({ok:true}));
    const signal=init!.signal!;
    return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));
  });
  const logger={info:vi.fn(),warn:vi.fn()} as any;
  const worker=new DesktopBrowserControlWorker({serverUrl:"http://127.0.0.1:17874",token:"test-token",executorToken:"test-executor",instanceId:"test-instance",getWindow:()=>null,logger});
  try {
    worker.start();expect(paths).toHaveLength(1);
    deadlines[0]!.abort(new DOMException("Request expired","TimeoutError"));
    await vi.waitFor(()=>expect(paths).toHaveLength(3),{timeout:4000});
    expect(paths[1]).toMatch(/\/register$/);expect(paths[2]).toMatch(/\/next$/);
    expect(logger.info).toHaveBeenCalledWith("browser control worker registered",{instanceId:"test-instance"});
    worker.stop();await Promise.resolve();await Promise.resolve();
    expect(paths).toHaveLength(3);
  } finally {worker.stop();fetch.mockRestore();timeout.mockRestore();}
});
