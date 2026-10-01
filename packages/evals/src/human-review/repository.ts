import type { HumanReview, HumanReviewCommand } from "./contracts.js";
export type HumanOperationReceipt = { requestHash: string; reviewId: string; revision: number };
export interface HumanReviewTransaction {
  get(id: string, revision?: number): Promise<HumanReview | null>;
  put(record: HumanReview, expectedRevision: number): Promise<void>;
  list(query: { afterId?: string; limit: number; projectId?: string }): Promise<{ items: HumanReview[]; nextCursor: string | null }>;
  operation(id: string): Promise<HumanOperationReceipt | null>;
  saveOperation(id: string, receipt: HumanOperationReceipt): Promise<void>;
}
/** Serialize and atomically roll back all review mutations in one scope. */
export interface HumanReviewRepository { transaction<T>(scope: string, callback: (tx: HumanReviewTransaction) => Promise<T>): Promise<T> }
export type HumanReviewContext = { scope: string; actorId: string };
export type HumanReviewAuthority = {
  /** Current membership and resource authority, never a caller-supplied role. */
  owner(context: HumanReviewContext, projectId: string): Promise<boolean>;
  member(context: HumanReviewContext): Promise<void>;
  /** Includes dataset/grader/rubric pins and exact output/trace identities. Never shares evidence. */
  evidence(context: HumanReviewContext, record: Pick<HumanReview, "projectId" | "evidence" | "form">): Promise<void>;
  publication?(context:HumanReviewContext,record:HumanReview,release:HumanReview["evidence"]["dataset"],proposalHash:string):Promise<void>;
  completeExecution?(context:HumanReviewContext,record:HumanReview,result:NonNullable<HumanReview["execution"]>["result"]):Promise<void>;
  execution?(context:HumanReviewContext,record:HumanReview,binding:NonNullable<HumanReview["execution"]>):Promise<void>;
  assignee(context: HumanReviewContext, actorId: string, record: Pick<HumanReview, "projectId" | "evidence" | "form">): Promise<void>;
};
export type HumanReviewExecutionOwner = { dispatch(context: HumanReviewContext, review: HumanReview, command: HumanReviewCommand): Promise<unknown> };
