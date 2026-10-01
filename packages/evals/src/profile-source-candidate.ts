import {z} from "zod";
import {ImmutableReleaseRefSchema} from "@openpond/harness";
/** An identity to resolve through the actual private hosted source owner. It is
 * never itself an authorization or a model-artifact declaration. */
export const ProfileSourceCandidateSchema=z.object({candidateId:z.string().min(1).max(240),frozenRevision:z.number().int().positive(),frozenHash:z.string().regex(/^[a-f0-9]{64}$/),harnessRelease:ImmutableReleaseRefSchema,protectedClosureHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type ProfileSourceCandidate=z.infer<typeof ProfileSourceCandidateSchema>;
