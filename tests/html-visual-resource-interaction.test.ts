import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { htmlVisualDocument } from "../packages/contracts/src/html-visual-document";

// Failure story: authored HTML must not select resources by script, synthetic
// clicks, or messages from a different iframe; a real resource button must work.
test("sandbox resource selection forwards only the bootstrap-owned trusted-click channel", () => {
  const messages: Record<string, unknown>[] = [];
  let receive: ((event: unknown) => void) | undefined;
  const authorWindow = {};
  const frame = { contentWindow:authorWindow, style:{}, srcdoc:"" };
  const outerWindow = {};
  const outer = htmlVisualDocument('<button data-openpond-resource-kind="dataset" data-openpond-resource-id="examples" data-openpond-resource-revision="3">Select</button>',"test-visual");
  runInNewContext(outer.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    window:outerWindow,parent:{postMessage:(message:Record<string,unknown>)=>messages.push(message)},
    document:{querySelector:()=>frame},
    addEventListener:(type:string,callback:(event:unknown)=>void)=>{if(type==="message")receive=callback;},
  });
  const click: ((event: unknown)=>void)[] = [];
  const bootstrap=frame.srcdoc.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  runInNewContext(bootstrap,{
    crypto:webcrypto,Uint32Array,
    parent:{postMessage:(data:Record<string,unknown>)=>receive!({source:authorWindow,data})},
    document:{getElementById:()=>({textContent:""}),addEventListener:(type:string,callback:(event:unknown)=>void)=>{if(type==="click")click.push(callback);}},
    addEventListener:()=>{},ResizeObserver:class{observe(){}},console:{log(){},warn(){},error(){}},
  });
  receive!({source:authorWindow,data:{type:"openpond-resource-select",identity:"test-visual",resource:{kind:"dataset",id:"forged",revision:1}}});
  receive!({source:{},data:{type:"openpond-resource-select",identity:"test-visual",resourceToken:"forged",resource:{kind:"dataset",id:"forged",revision:1}}});
  const target={closest:()=>({disabled:false,dataset:{openpondResourceKind:"dataset",openpondResourceId:"examples",openpondResourceRevision:"3"}})};
  click[0]!({isTrusted:false,target});
  expect(messages).toEqual([]);
  click[0]!({isTrusted:true,target});
  expect(messages).toEqual([{type:"openpond-visual-resource-select",identity:"test-visual",resource:{kind:"dataset",id:"examples",revision:3}}]);
});
