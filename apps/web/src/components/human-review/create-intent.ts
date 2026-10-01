import {contentHash} from "@openpond/harness";
/** Retain only an opaque operation seed. No task, response, rubric, or credential
 * bytes enter browser storage; server receipts remain authoritative. */
export function retainHumanCreateIntent(authority:unknown,intent:unknown){
  const key=`openpond.human-create.${contentHash([authority,intent])}`;
  let seed:string;
  try{seed=window.localStorage.getItem(key)??crypto.randomUUID();if(!/^[0-9a-f-]{36}$/i.test(seed))throw new Error("Invalid operation seed");window.localStorage.setItem(key,seed);}catch{throw new Error("Browser operation recovery storage is unavailable. Enable local storage before creating assignments.");}
  return {key,seed};
}
export function finishHumanCreateIntent(intent:{key:string;seed:string}){if(window.localStorage.getItem(intent.key)===intent.seed)window.localStorage.removeItem(intent.key);}
export function humanCreateIdentity(seed:string,taskId:string){return `human-${contentHash([seed,taskId])}`;}
