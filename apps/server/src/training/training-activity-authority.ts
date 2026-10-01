import {z} from 'zod';
export const TrainingActivityAuthoritySchema=z.object({schemaVersion:z.literal('openpond.trainingActivityAuthority.v1'),teamId:z.string().min(1),actorId:z.string().min(1),projectId:z.string().min(1).nullable()}).strict();
export type TrainingActivityAuthority=z.infer<typeof TrainingActivityAuthoritySchema>;
export type ResolveTrainingActivityAuthority=(modelId:string)=>Promise<TrainingActivityAuthority>;
const admissions=new WeakMap<object,TrainingActivityAuthority>();
export function bindTrainingActivityAuthority(plan:object,authority:TrainingActivityAuthority){admissions.set(plan,TrainingActivityAuthoritySchema.parse(authority));}
export function boundTrainingActivityAuthority(plan:object){return admissions.get(plan)??null;}
