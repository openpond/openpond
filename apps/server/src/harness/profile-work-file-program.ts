/** Runs exclusively in the admitted case namespace. Descriptor traversal
 * prevents a policy-created symlink from selecting another namespace. */
export const profileWorkFileProgram = String.raw`
const fs=require('node:fs'),p=require('node:path');
const a=JSON.parse(fs.readFileSync(0,'utf8'));
const roots={work:'outputs',inputs:'inputs',harness:'harness'};
if(!Object.hasOwn(roots,a.root)||typeof a.path!=='string'||!a.path||p.isAbsolute(a.path)||a.path.includes('\\')||a.path.includes('\0')||a.path.split('/').some(s=>!s||s==='.'||s==='..'))throw Error('Select a contained Work file.');
let fd=fs.openSync('/workspace/work',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
try {
 const parts=[roots[a.root],...a.path.split('/')];
 for(const part of parts.slice(0,-1)){
  const next=fs.openSync('/proc/self/fd/'+fd+'/'+part,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);fs.closeSync(fd);fd=next;
 }
 const leaf=fs.openSync('/proc/self/fd/'+fd+'/'+parts.at(-1),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{
  const stat=fs.fstatSync(leaf),offset=a.offset??0,maxBytes=a.maxBytes??4000;
  if(!stat.isFile()||stat.size>10000000||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>20000)throw Error('Select a bounded regular Work file and read window.');
  const bytes=Buffer.alloc(Math.min(maxBytes,Math.max(0,stat.size-offset))),n=fs.readSync(leaf,bytes,0,bytes.length,offset),nextOffset=offset+n;
  process.stdout.write(JSON.stringify({root:a.root,path:a.path,text:bytes.subarray(0,n).toString('utf8'),sizeBytes:stat.size,offset,nextOffset,truncated:nextOffset<stat.size}));
 } finally{fs.closeSync(leaf);}
}finally{fs.closeSync(fd);}
`;
