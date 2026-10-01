import {useState,type CSSProperties,type ReactNode} from "react";
import {WorkspacePanelHost,WorkspacePanelToolbar,useWorkspacePanelControls} from "../labs/workspace/WorkspacePanel";
import "../../styles/labs/evaluation-workspace.css";

/** Inbox editors use the same retained portal host and panel controls as the
 * Experiment workspace, including collapse, keyboard and pointer resizing. */
export function HumanInboxFrame({children}:{children:ReactNode}){
 const panel=useWorkspacePanelControls(),[host,setHost]=useState<HTMLDivElement|null>(null);
 return <section className="evaluation-workspace" data-panel-open={Boolean(panel?.open)}
  style={{"--evaluation-panel-width":`${panel?.width??440}px`} as CSSProperties}>
  <WorkspacePanelHost.Provider value={host}>
   <div className="evaluation-workspace-main">{children}</div>
   <aside className="evaluation-workspace-panel" aria-label="Details sidebar">
    <div className="evaluation-panel-resize" role="separator" tabIndex={0} aria-label="Resize sidebar"
     aria-orientation="vertical" aria-valuemin={320} aria-valuemax={800} aria-valuenow={panel?.width??440}
     onKeyDown={event=>{if(event.key!=="ArrowLeft"&&event.key!=="ArrowRight")return;event.preventDefault();panel?.resize((panel.width??440)+(event.key==="ArrowLeft"?24:-24));}}
     onPointerDown={event=>event.currentTarget.setPointerCapture(event.pointerId)}
     onPointerMove={event=>{if(!event.currentTarget.hasPointerCapture(event.pointerId))return;const rect=event.currentTarget.parentElement?.getBoundingClientRect();if(rect)panel?.resize(rect.right-event.clientX);}}
     onPointerUp={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}/>
    <WorkspacePanelToolbar/>
    <div ref={setHost}/>
   </aside>
  </WorkspacePanelHost.Provider>
 </section>;
}
