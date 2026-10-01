import { z } from "zod";
import { ReleaseIdSchema } from "@openpond/harness";
const RelativePathSchema=z.string().min(1).max(2000).refine(value=>!value.includes("\\")&&!value.includes(":")&&!value.startsWith("/")&&value.split("/").every(part=>part!==""&&part!=="."&&part!==".."),"Evaluation paths must be portable and relative.");
export const ProfileEvaluationTargetSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("profile")}).strict(),z.object({kind:z.literal("workflow"),workflowId:ReleaseIdSchema}).strict(),
  z.object({kind:z.literal("skill"),skillPath:RelativePathSchema}).strict(),z.object({kind:z.literal("agent_action"),actionId:ReleaseIdSchema}).strict()]);
