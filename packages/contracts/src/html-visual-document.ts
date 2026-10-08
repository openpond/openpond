import { HTML_VISUAL_MAX_HEIGHT, HTML_VISUAL_THEME, type HtmlVisualTheme } from "./html-visuals.js";

// The trusted outer document contains no author markup. Its frame-src policy
// prevents the author frame navigating itself to a network URL; the inner CSP
// also denies all subresources except inline code and embedded raster images.
const POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function htmlVisualDocument(html: string, identity: string, initialTheme: HtmlVisualTheme = HTML_VISUAL_THEME): string {
  const innerBootstrap = `(() => {
    const style = document.getElementById('openpond-theme');
    const keys = ${json(Object.keys(HTML_VISUAL_THEME))};
    function theme(values) { if (!values || typeof values !== 'object') return;
      style.textContent = ':root{' + keys.map(k => k+':'+String(values[k]||'').replace(/[;{}<>]/g,'')+';').join('') + '}'; }
    theme(${json(initialTheme)});
    addEventListener('message', e => { if(e.source === parent && e.data?.type === 'openpond-theme') theme(e.data.theme); });
    const send = data => parent.postMessage({ ...data, identity: ${json(identity)} }, '*');
    let interactionPending=false;
    for(const type of ['wheel','touchmove','pointerdown','keydown']) addEventListener(type,e=>{
      if(!e.isTrusted || interactionPending)return; interactionPending=true;
      requestAnimationFrame(()=>{interactionPending=false;send({type:'openpond-interaction'});});
    },{passive:true});
    let queued = false, previous = 0, loaded = false, reportedReady = false;
    function measure() { if(queued)return; queued=true; requestAnimationFrame(() => { queued=false;
      const body = document.body; if(!body)return;
      const height = Math.max(80, Math.ceil(Math.max(body.getBoundingClientRect().height, body.scrollHeight)));
      if(height!==previous || (loaded && !reportedReady)) { previous=height; reportedReady=loaded; send({type:'openpond-size',height,ready:loaded}); }
    }); }
    const observer = new ResizeObserver(measure);
    addEventListener('DOMContentLoaded', () => { observer.observe(document.body); measure(); });
    addEventListener('load', () => { void document.fonts.ready.then(() => { loaded=true; measure(); }); });
    let count=0;
    function log(level,args){ if(count++<40)send({type:'openpond-console',level,text:args.map(v=>{try{return typeof v==='string'?v:JSON.stringify(v)}catch{return String(v)}}).join(' ').slice(0,2000)}); }
    for(const level of ['log','warn','error']) { const original=console[level]; console[level]=(...args)=>{log(level,args);original.apply(console,args)}; }
    addEventListener('error', e => log('error',[e.message]));
    addEventListener('unhandledrejection', e => log('error',[String(e.reason)]));
    addEventListener('securitypolicyviolation', e => log('error',['Blocked resource: '+e.violatedDirective+' ('+e.blockedURI+')']));
    // Links are informational inside a self-contained visual, never navigation.
    document.addEventListener('click', e => { if(e.composedPath().some(n=>n?.tagName==='A'))e.preventDefault(); }, true);
  })();`;
  const inner = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${attr(POLICY)}"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="openpond-theme"></style><style>html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font-web)}body{display:flow-root;overflow-wrap:anywhere}*{box-sizing:border-box}img,svg,canvas{max-width:100%}button,input,select{font:inherit}button{cursor:pointer}html{scrollbar-width:none}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style><script>${innerBootstrap}</script></head><body>${html}</body></html>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${attr(POLICY)}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:transparent}iframe{display:block;border:0;width:100%;height:80px;color-scheme:dark}</style></head><body><iframe title="Interactive visual" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"></iframe><script>(()=>{
    const frame=document.querySelector('iframe'); const identity=${json(identity)};
    const state=window.__openpondVisual={height:80,console:[],ready:false};
    let pending=false;
    addEventListener('message', e=>{
      const d=e.data;if(!d||typeof d!=='object')return;
      if(e.source===parent && parent!==window && d.type==='openpond-theme' && d.identity===identity){frame.contentWindow.postMessage({type:'openpond-theme',theme:d.theme},'*');return;}
      if(e.source!==frame.contentWindow || d.identity!==identity)return;
      if(d.type==='openpond-interaction' && parent!==window)parent.postMessage({type:'openpond-visual-interaction',identity},'*');
      if(d.type==='openpond-console' && state.console.length<40 && ['log','warn','error'].includes(d.level) && typeof d.text==='string')state.console.push({level:d.level,text:d.text.slice(0,2000)});
      if(d.type==='openpond-size' && Number.isFinite(d.height)){
        const height=Math.max(80,Math.min(${HTML_VISUAL_MAX_HEIGHT},Math.ceil(d.height)));state.height=height;if(d.ready===true)state.ready=true;
        if(!pending){pending=true;requestAnimationFrame(()=>{pending=false;frame.style.height=state.height+'px';if(parent!==window)parent.postMessage({type:'openpond-visual-size',identity,height:state.height},'*');});}
      }
    });
    frame.srcdoc=${json(inner)};
  })();</script></body></html>`;
}
