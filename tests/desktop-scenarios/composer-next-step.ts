import { desktopScenario } from "../../scripts/desktop-harness/scenario.js";

// Failure story: suggestion acceptance must never send, overwrite typing, or cross a chat/revision boundary.
// Exercise the real hook and contenteditable in Chromium; intercept only this isolated fixture's URL.
export default desktopScenario({
  name: "composer-next-step", mode: "attach", timeoutMs: 30_000,
  async run(harness) {
    const result = await harness.renderer.evaluate<Record<string,boolean>>(`(async()=>{const loadedModule=name=>{const entry=performance.getEntriesByType('resource').find(entry=>{const url=new URL(entry.name);return url.pathname.endsWith('/'+name)&&url.searchParams.has('v')});if(!entry)throw Error('Missing app module '+name);return entry.name;};
const reactModule=await import(loadedModule('react.js'));const React=reactModule.default??reactModule;const {useRef,useState,useEffect}=React;
const domModule=await import(loadedModule('react-dom_client.js'));const {createRoot}=domModule.default??domModule;
const {useComposerNextStep}=await import('/src/components/chat/useComposerNextStep.ts');
const {ComposerInlineInput}=await import('/src/components/chat/ComposerInlineInput.tsx');
const {ComposerNextStep}=await import('/src/components/chat/ComposerNextStep.tsx');
const {COMPOSER_RESOURCE_REQUEST}=await import('/src/components/chat/composer-resource-request.ts');
const {createComposerDraftStore}=await import('/src/lib/composer-draft-store.ts');
const draft=createComposerDraftStore();
const host=document.createElement('div');host.style.cssText='position:fixed;left:-10000px;width:600px';document.body.append(host);const priorFocus=document.activeElement;

let id = 0, consumed = false, dismissed = false, commits = 0, hold = false, release = () => { }, sent = 0, reads = 0, accepts = 0, pinned;
const connection = { serverUrl: location.origin + '/next-step-boundary-fixture', token: 'fixture', platform: 'linux' };
const response = () => ({ id: \`suggestion-\${id}\`, sessionId: 'proof', sourceTurnId: 'turn', action: 'diagnose', label: 'Inspect the retained result', draft: 'Inspect experiment run-A without starting paid work.', contexts: [{ scopeId: 'scope', selectionVersion: 1, resources: [{ kind: 'experiment', id: 'run-A', revision: 1 }] }], focus: { target: { kind: 'experiment', id: 'run-A', location: 'local' }, label: 'Run A', detail: '' } });
const realFetch = window.fetch;
window.fetch = async (_url, options) => { if (!String(_url).includes('/next-step-boundary-fixture/'))
    return realFetch(_url, options); const payload = JSON.parse(options?.body).payload; if (payload.operation === 'accept') {
    accepts++;
    if (hold)
        await new Promise(r => release = r);
    consumed = true;
    return Response.json({ suggestion: response() });
} if (payload.operation === 'dismiss') {
    dismissed = true;
    return Response.json({ suggestion: null });
} reads++; if(consumed&&!dismissed){id++;consumed=false;} return Response.json({ suggestion: dismissed ? null : response() }); };
function Fixture() {
    const prompt=React.useSyncExternalStore(draft.subscribe,draft.getSnapshot);const setPrompt=draft.set;
    const [,setCursor]=useState(0), [blocked,setBlocked]=useState(false), [sessionId,setSession]=useState('proof'), [version,setVersion]=useState(0);
    const input = useRef(null);
    const next = useComposerNextStep({ connection, sessionId, events: [], blocked, prompt, selectionKey: String(version), inputRef: input });
    useEffect(() => { const listener = (e) => { if (e.detail.sessionId === sessionId) {
        pinned = e.detail.contexts;
        setPrompt(e.detail.text);
    } }; window.addEventListener(COMPOSER_RESOURCE_REQUEST, listener); return () => window.removeEventListener(COMPOSER_RESOURCE_REQUEST, listener); }, [sessionId]);
    window.proof = { reset: () => { id++; consumed = false; dismissed = false; hold = false; sent = 0; accepts = 0; pinned = null; setPrompt(''); setCursor(0); setBlocked(false); setSession('proof'); setVersion(v => v + 1); }, setPrompt, setBlocked, setSession, revise: () => setVersion(v => v + 1), hold: () => hold = true, release: () => release(), resetCommits:()=>commits=0, state: () => ({ prompt, sent, accepts, reads, pinned, ghost: !!next.suggestion, sessionId, commits }), input: () => input.current.element };
    return React.createElement("main", { style: { width: 700, margin: 80 } },
        React.createElement("form", { className: "composer", onSubmit: e => e.preventDefault() },
            React.createElement("div", { className: "composer-textarea-frame", onCompositionStartCapture: next.onCompositionStart, onCompositionEndCapture: next.onCompositionEnd },
                React.createElement(ComposerNextStep, { next: next }),
                React.createElement(ComposerInlineInput, { ref: input, prompt: prompt, disabled: false, ariaDescribedBy:next.suggestion?next.descriptionId:undefined, placeholder: next.suggestion ? '' : 'Type', token: null, onTokenPositionChange: () => { }, onCursorChange:setCursor, onPromptChange:setPrompt, onKeyDown: e => { if (next.onKeyDown(e))
                        return; if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sent++;
                    } } }))));
}
const fixtureRoot = createRoot(host);
fixtureRoot.render(React.createElement(React.Profiler,{id:"draft-bound-input",onRender:()=>commits++},React.createElement(Fixture, null)));

try{const wait=async(p)=>{for(let i=0;i<100;i++){if(p())return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out')};await wait(()=>window.proof?.state().ghost);const results={};const key=(name,extra={})=>proof.input().dispatchEvent(new KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true,...extra}));const reset=async()=>{proof.reset();await wait(()=>proof.state().ghost)};
results.arrivalPreservesFocus=document.activeElement===priorFocus;proof.input().focus();results.focusPreserves=proof.state().ghost;key('Enter');await wait(()=>!!proof.state().prompt);results.enterDraftOnly=proof.state().sent===0&&proof.state().accepts===1&&proof.state().pinned[0].resources[0].id==='run-A';key('Enter',{repeat:true});results.repeatDoesNotSend=proof.state().sent===0;key('Enter');results.separateEnterSends=proof.state().sent===1;
proof.setPrompt('');await wait(()=>proof.state().ghost);results.clearedAcceptedDraftRestores=proof.state().accepts===1&&proof.state().sent===1;
await reset();key('Enter',{isComposing:true});await new Promise(r=>setTimeout(r,60));results.imeOwnsInput=proof.state().accepts===0&&proof.state().sent===0&&!proof.state().ghost;proof.input().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));await wait(()=>proof.state().ghost);key('Tab');await wait(()=>!!proof.state().prompt);results.tabDraftOnly=proof.state().sent===0;
await reset();key('Escape');await wait(()=>!proof.state().ghost);results.dismissNoSend=proof.state().sent===0&&proof.state().prompt==='';
await reset();proof.setBlocked(true);await wait(()=>!proof.state().ghost);results.blockedHidden=true;proof.setPrompt('Existing draft');proof.setBlocked(false);await new Promise(r=>setTimeout(r,80));results.existingDraftWins=!proof.state().ghost&&proof.state().prompt==='Existing draft';
await reset();proof.hold();key('Enter');await wait(()=>proof.state().accepts===1);proof.setPrompt('Typed while awaiting validation');await wait(()=>proof.state().prompt==='Typed while awaiting validation');proof.release();await new Promise(r=>setTimeout(r,80));results.typingWins=proof.state().prompt==='Typed while awaiting validation'&&proof.state().sent===0;
await reset();proof.hold();key('Enter');await wait(()=>proof.state().accepts===1);proof.setSession('another-chat');await wait(()=>proof.state().sessionId==='another-chat');proof.release();await new Promise(r=>setTimeout(r,80));results.crossChatCannotInsert=proof.state().prompt==='';
await reset();proof.hold();key('Enter');await wait(()=>proof.state().accepts===1);proof.revise();await new Promise(r=>setTimeout(r,60));proof.release();await new Promise(r=>setTimeout(r,80));results.revisionCannotInsert=proof.state().prompt==='';
await reset();
host.style.left='20px';host.style.top='20px';host.style.zIndex='2147483647';await new Promise(r=>requestAnimationFrame(r));const input=proof.input();const ghost=host.querySelector('.composer-next-step');const rect=input.getBoundingClientRect();results.pointerReachesEditable=document.elementFromPoint(rect.left+4,rect.top+8)===input;input.focus();const selection=getSelection();results.editableCaretAndDescription=selection?.anchorNode&&(selection.anchorNode===input||input.contains(selection.anchorNode))&&!!document.getElementById(input.getAttribute('aria-describedby'))&&!ghost.querySelector('button,[title]');
key('z');document.execCommand('insertText',false,'z');await wait(()=>proof.state().prompt==='z');await new Promise(r=>requestAnimationFrame(r));results.typingHidesImmediately=!proof.state().ghost&&proof.state().sent===0;proof.setPrompt('');await wait(()=>proof.state().ghost);results.clearedTypedDraftRestores=proof.state().accepts===0;
const data=new DataTransfer();data.setData('text/plain','Pasted draft');input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));await wait(()=>proof.state().prompt==='Pasted draft');results.pasteOwnsDraft=!proof.state().ghost&&proof.state().sent===0;
host.style.left='-10000px';await reset();proof.setSession(null);await wait(()=>!proof.state().ghost&&proof.state().sessionId===null);await new Promise(r=>setTimeout(r,60));proof.resetCommits();proof.input().focus();document.execCommand('insertText',false,'r');await wait(()=>proof.state().prompt==='r');await new Promise(r=>setTimeout(r,60));results.idleTypingHasNoClearingCommit=proof.state().commits===1;
return results;}finally{fixtureRoot.unmount();host.remove();window.fetch=realFetch;delete window.proof;if(priorFocus instanceof HTMLElement&&priorFocus.isConnected)priorFocus.focus();}})()`);
    for (const [name, passed] of Object.entries(result)) {
      harness.recordAssertion(name, passed);
      if (!passed) throw new Error(`Composer next-step lifecycle failed: ${name}`);
    }
  },
});
