import type {Session,Turn} from '@openpond/contracts';
/** Only an in-process owner can supply this callback. Public turn payloads do
 * not admit candidates or receive authority from their metadata. */
export type StoredTurnAdmission={beforeExecute(session:Session,turn:Turn):Promise<void>};
export async function admitStoredTurn(input:{session:Session;turn:Turn;admission?:StoredTurnAdmission;failTurn(session:Session,turnId:string,message:string):Promise<Turn>}) {
  if(!input.admission)return;
  try{await input.admission.beforeExecute(input.session,input.turn);}
  catch(error){await input.failTurn(input.session,input.turn.id,error instanceof Error?error.message:'The execution owner rejected this stored turn.');throw error;}
}
