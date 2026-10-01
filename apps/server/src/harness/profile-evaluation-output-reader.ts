import {createHash} from "node:crypto";
import {z} from "zod";
import {WORK_OUTPUT_MAX_BYTES} from "@openpond/contracts";
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
/** Read only inside the admitted target OS namespace. A target-controlled
 * symlink is never reopened on the host, and changing bytes cannot be sealed. */
export async function readConfinedProfileOutput(input:{path:string;command(body:string):Promise<{code:number|null;stdout:string}>}){
 const selected=input.path.replace(/^\/workspace\/work\/outputs\//,"").replace(/^outputs\//,"");
 if(!selected||selected.startsWith("/")||selected.split(/[\\/]/).some(part=>!part||part==="."||part==="..")||selected.includes("\0"))throw new Error("Select one file inside this case's writable outputs.");
 const program="const f=require('fs'),p=require('path'),c=require('crypto'),a=JSON.parse(process.argv[1]),r=f.realpathSync('/workspace/work/outputs'),q=f.realpathSync(p.join(r,a.path));if(!q.startsWith(r+'/'))throw Error('Output path escapes the case');const s=f.statSync(q);if(!s.isFile()||s.size>10000000)throw Error('Output exceeds its bound');if(a.offset===undefined){const b=f.readFileSync(q);process.stdout.write(JSON.stringify({size:b.length,hash:c.createHash('sha256').update(b).digest('hex')}))}else{const h=f.openSync(q,'r'),b=Buffer.alloc(Math.min(524288,s.size-a.offset));try{const n=f.readSync(h,b,0,b.length,a.offset);process.stdout.write(b.subarray(0,n).toString('base64'))}finally{f.closeSync(h)}}";
 async function read(offset?:number){const result=await input.command(`/runtime/node -e ${quote(program)} ${quote(JSON.stringify({path:selected,...(offset!==undefined?{offset}:{})}))}`);if(result.code!==0)throw new Error("The confined output could not be read.");return result.stdout;}
 const expected=z.object({size:z.number().int().min(1).max(WORK_OUTPUT_MAX_BYTES),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(await read())),chunks:Buffer[]=[];
 for(let offset=0;offset<expected.size;offset+=524288){const encoded=await read(offset);if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||encoded.length>700000)throw new Error("Output chunk exceeded its boundary.");const bytes=Buffer.from(encoded,"base64");if(bytes.length!==Math.min(524288,expected.size-offset))throw new Error("The output changed during readback.");chunks.push(bytes);}
 const bytes=Buffer.concat(chunks),hash=createHash("sha256").update(bytes).digest("hex"),after=z.object({size:z.number(),hash:z.string()}).strict().parse(JSON.parse(await read()));
 if(hash!==expected.hash||after.hash!==hash||after.size!==bytes.length)throw new Error("The output changed before immutable readback.");
 return{bytes,title:selected.split("/").at(-1)!};
}
