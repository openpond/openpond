import {useState} from "react";
import type {ChatResourceSummary} from "@openpond/contracts";
import type {ClientConnection} from "../../api/api-client";
import {chatResourceRequest} from "../../api/chat-resource-api";
export function RelatedResourceChats({resource,connection}:{resource:ChatResourceSummary;connection:ClientConnection|null}) {
  const [chats,setChats]=useState<{id:string;title:string}[]|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  async function open(){if(chats){setChats(null);return;}if(!connection || busy)return;setBusy(true);setError(null);try{setChats(await chatResourceRequest(connection,"dataset",{action:"related_chats",id:resource.id,payload:{kind:resource.kind}}));}catch(error){setError(error instanceof Error ? error.message : "Related chats unavailable.");}finally{setBusy(false);}}
  return <div className="chat-resource-related"><button type="button" className="training-text-button" disabled={!connection || busy} onClick={()=>void open()}>{chats ? "Hide related chats" : "Related chats"}</button>{chats && <table className="training-data-table"><thead><tr><th>Conversation</th></tr></thead><tbody>{chats.length ? chats.map(chat=><tr key={chat.id}><td><a href={`/chat/${encodeURIComponent(chat.id)}`}>{chat.title}</a></td></tr>) : <tr><td>No linked conversations.</td></tr>}</tbody></table>}{error && <p role="alert" className="chat-resource-error">{error}</p>}</div>;
}
