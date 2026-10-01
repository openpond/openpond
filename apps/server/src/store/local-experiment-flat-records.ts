import { contentHash } from "@openpond/harness";
import { LocalExperimentConfigurationSnapshotSchema,LocalExperimentRecordSchema,
  type LocalExperimentConfigurationSnapshot } from "@openpond/contracts";
import { validateTasksetPackage } from "openpond-sdk/taskset-packages";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { localDefinition,localExecution } from "./local-experiment-records.js";
import { LocalExperimentError,type LocalExperimentExecution } from "../evaluations/local-experiment-contract.js";

export function localFlatSnapshot(db:OpenPondSqliteConnection,execution:LocalExperimentExecution) {
  if(execution.kind!=="target")throw new LocalExperimentError("local_experiment_not_found","This id names a scoring pass, not an Experiment.",404);
  const row=db.get<{payload:string;package_payload:string}>("SELECT payload,package_payload FROM local_experiment_configurations WHERE team_id=? AND execution_id=?",[execution.teamId,execution.id]);
  if(row) {
    const snapshot=LocalExperimentConfigurationSnapshotSchema.parse(JSON.parse(row.payload)),packageValue=validateTasksetPackage(JSON.parse(row.package_payload));
    if(snapshot.packageHash!==packageValue.contentHash||snapshot.packageHash!==execution.packageHash)
      throw new LocalExperimentError("local_package_pin_conflict","The retained Experiment package differs from its admission.");
    return {snapshot,package:packageValue};
  }
  // Historical projection normalizes only transport operation identities. The
  // sealed original request/admissions/results remain untouched and addressable.
  const retained=localDefinition(db,execution.teamId,execution.definition.id,execution.definition.revision),definition=retained.definition;
  const packageValue=validateTasksetPackage(retained.package);
  const {contentHash:retainedHash,...retainedContent}=definition;
  if(contentHash(retainedContent)!==retainedHash)
    throw new LocalExperimentError("local_configuration_pin_conflict","The retained configuration bytes differ from their sealed hash.");
  if(definition.contentHash!==execution.definition.contentHash||definition.ownerActorId!==execution.ownerActorId
    ||definition.teamId!==execution.teamId||definition.packageHash!==execution.packageHash||packageValue.contentHash!==execution.packageHash)
    throw new LocalExperimentError("local_configuration_pin_conflict","The retained Experiment configuration differs from its owner or immutable admission.");
  const original=definition.configuration;
  const body={configuration:{operationId:execution.operationId,request:{...original.request,operationId:execution.operationId},
    maximumCostUsd:original.maximumCostUsd,...(original.graders?{graders:original.graders}:{})},model:definition.model,
    packageHash:definition.packageHash,graders:definition.graders,availableGraders:definition.availableGraders,
    retainedConfigurationHash:definition.contentHash};
  const snapshot=LocalExperimentConfigurationSnapshotSchema.parse({...body,configurationHash:contentHash(body)});
  writeLocalFlatSnapshot(db,execution,snapshot,packageValue);
  return {snapshot,package:packageValue};
}
export function writeLocalFlatSnapshot(db:OpenPondSqliteConnection,execution:LocalExperimentExecution,snapshot:LocalExperimentConfigurationSnapshot,packageValue:unknown) {
  db.run("INSERT INTO local_experiment_configurations(team_id,execution_id,payload,package_payload) VALUES(?,?,?,?)",
    [execution.teamId,execution.id,JSON.stringify(snapshot),JSON.stringify(packageValue)]);
}
export function localFlatRecord(db:OpenPondSqliteConnection,teamId:string,id:string) {
  const execution=localExecution(db,teamId,id),{snapshot}=localFlatSnapshot(db,execution);
  const {definition,...publicExecution}=execution;
  void definition;
  return LocalExperimentRecordSchema.parse({...publicExecution,...snapshot});
}
