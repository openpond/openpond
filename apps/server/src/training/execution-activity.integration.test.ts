import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { NodeSqliteConnection } from "../store/sqlite/sqlite-driver-node.js";
import { LOCAL_EXPERIMENT_SCHEMA_SQL } from "../store/store-local-experiment-schema.js";
import { readLocalExecutionActivity } from "../store/local-execution-activity.js";

// Failure story: a bounded activity menu must neither undercount a larger queue
// nor reveal another account/tenant's execution after a Project change.
test("persisted activity counts the full authorized queue before limiting the menu", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "execution-activity-"));
  const filename = path.join(directory, "activity.sqlite");
  let database = new NodeSqliteConnection(filename);
  const request = (projectId:string) => ({configuration:{request:{name:projectId,project:{id:projectId}}}});
  try {
    database.exec(LOCAL_EXPERIMENT_SCHEMA_SQL);
    for (const teamId of ["team-a", "team-b"])
      database.run("INSERT INTO local_experiment_definitions VALUES(?,?,1,?,?,?,?)", [teamId,"definition","hash","project-a",JSON.stringify(request("project-a")),"{}"]);
    function insert(id:string,teamId:string,actorId:string,status:string,projectId="project-a") {
      database.run("INSERT INTO local_experiment_executions VALUES(?,?,?,1,?,?)", [teamId,id,"definition","runtime",JSON.stringify({ownerActorId:actorId,status,createdAt:"2026-10-01T00:00:00.000Z",startedAt:null})]);
      database.run("INSERT INTO local_experiment_configurations VALUES(?,?,?,?)",[teamId,id,JSON.stringify(request(projectId)),"{}"]);
    }
    for(let index=0;index<125;index++) insert(`owned-${index}`,"team-a","actor-a",["running","queued","cancelling"][index%3]!);
    insert("other-project","team-a","actor-a","running","project-b");
    insert("other-actor","team-a","actor-b","running");
    insert("other-tenant","team-b","actor-a","running");
    insert("terminal","team-a","actor-a","completed");
    database.close(); database=new NodeSqliteConnection(filename);
    const scope={teamId:"team-a",actorId:"actor-a",projectId:"project-a",limit:100};
    const activity=readLocalExecutionActivity(database,scope);
    expect(activity.count).toBe(125);expect(activity.items).toHaveLength(100);
    expect(activity.items.every(item=>item.id.startsWith("owned-"))).toBe(true);
    expect(readLocalExecutionActivity(database,{...scope,projectId:null}).count).toBe(126);
    expect(readLocalExecutionActivity(database,{...scope,projectId:"project-b"}).items.map(item=>item.id)).toEqual(["other-project"]);
    expect(readLocalExecutionActivity(database,{...scope,actorId:"actor-b"}).items.map(item=>item.id)).toEqual(["other-actor"]);
    expect(readLocalExecutionActivity(database,{...scope,teamId:"team-b"}).items.map(item=>item.id)).toEqual(["other-tenant"]);
    expect(readLocalExecutionActivity(database,{...scope,actorId:"revoked"}).count).toBe(0);
  } finally { database.close(); await rm(directory,{recursive:true,force:true}); }
});
