import type { OpenPondSqliteConnection } from './sqlite/sqlite-driver.js';
/** The menu bound is applied after counting the complete owner-scoped queue. */
export function readLocalExecutionActivity(db:OpenPondSqliteConnection,input:{teamId:string;actorId:string;projectId:string|null;limit:number}) {
  const rows=db.all<{id:string;payload:string;name:string|null;total:number}>(`SELECT e.id,e.payload,
    COALESCE(json_extract(c.payload,'$.configuration.request.name'),json_extract(d.payload,'$.configuration.request.name')) AS name,
    count(*) OVER () AS total FROM local_experiment_executions e
    LEFT JOIN local_experiment_configurations c ON c.team_id=e.team_id AND c.execution_id=e.id
    JOIN local_experiment_definitions d ON d.team_id=e.team_id AND d.id=e.definition_id AND d.revision=e.definition_revision
    WHERE e.team_id=? AND json_extract(e.payload,'$.ownerActorId')=?
    AND json_extract(e.payload,'$.status') IN ('queued','running','cancelling')
    ${input.projectId ? "AND COALESCE(json_extract(c.payload,'$.configuration.request.project.id'),json_extract(d.payload,'$.configuration.request.project.id'))=?" : ''}
    ORDER BY json_extract(e.payload,'$.updatedAt') DESC,e.id DESC LIMIT ?`,
    [input.teamId,input.actorId,...(input.projectId?[input.projectId]:[]),input.limit]);
  return {count:Number(rows[0]?.total??0),items:rows.map(row=>{
    const value=JSON.parse(row.payload) as {status:string;updatedAt?:string;startedAt:string|null;createdAt:string};
    return {kind:'experiment' as const,location:'local' as const,id:row.id,name:row.name??'Experiment',phase:value.status,updatedAt:value.updatedAt??value.startedAt??value.createdAt};
  })};
}
