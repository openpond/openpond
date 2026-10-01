import { z } from "zod";
import { ExperimentModelCaseSchema } from "./experiment-case-contract.js";
export { LocalExperimentSaveSchema, LocalExperimentSaveFromReleaseSchema, LocalExperimentDefinitionSchema, LocalExperimentStartSchema, LocalExperimentReadSchema,
  LocalExperimentListSchema, LocalExperimentExecutionSchema, LocalExperimentScoreSchema,
  type LocalExperimentDefinition, type LocalExperimentExecution, type LocalCaseStatus } from "@openpond/contracts";

const Id = z.string().trim().min(1).max(200);
/** Private execution admission is stored only behind the local capability
 * boundary. API inspection projects policy-visible input and retained output. */
export const LocalExperimentAdmissionSchema = z.object({
  receiptId: Id, taskId: Id, seed: z.string(), request: ExperimentModelCaseSchema,
}).strict();
export type LocalExperimentAdmission = z.infer<typeof LocalExperimentAdmissionSchema>;
export type LocalCharge = { requestId:string;caseId:string;maximumUsd:number;costUsd:number|null;
  status:"reserved"|"dispatched"|"settled"|"unknown"|"released";usage:unknown|null };
export class LocalExperimentError extends Error {
  constructor(readonly code:string, message:string, readonly status=409) { super(message); }
}
