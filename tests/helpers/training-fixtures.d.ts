import { type TaskAttemptResult, type Taskset, type TrainingDestinationId, type TrainingPlan, type TrainingSourceRef } from "../../packages/contracts/src";
import { SqliteStore } from "../../apps/server/src/store/store";
export declare const FIXED_TIME = "2026-07-12T00:00:00.000Z";
export declare function sourceFixture(id?: string, clusterKey?: string, sessionId?: string): TrainingSourceRef;
export declare function tasksetFixture(options?: {
    ready?: boolean;
    profileId?: string;
    graders?: Taskset["graders"];
}): Taskset;
export declare function sftRecipeFixture(): any;
export declare function planFixture(taskset?: Taskset, destinationId?: TrainingDestinationId): TrainingPlan;
export declare function preferenceTasksetFixture(): Taskset;
export declare function rewardTasksetFixture(): Taskset;
export declare function dpoRecipeFixture(): any;
export declare function ppoRecipeFixture(taskset?: Taskset): any;
export declare function executablePlanFixture(taskset: Taskset, recipe: ReturnType<typeof dpoRecipeFixture> | ReturnType<typeof ppoRecipeFixture>): TrainingPlan;
export declare function attemptFixture(input?: Partial<TaskAttemptResult>): TaskAttemptResult;
export declare function proposalFixture(sourceIds?: string[]): any;
export declare function withTrainingStore<T>(run: (input: {
    store: SqliteStore;
    directory: string;
}) => Promise<T>): Promise<T>;
export declare function seedConversation(store: SqliteStore, input?: {
    sessionId?: string;
    turnId?: string;
    title?: string;
    prompt?: string;
    assistant?: string;
}): Promise<{
    session: Session;
    turn: Turn;
    event: RuntimeEvent;
}>;
//# sourceMappingURL=training-fixtures.d.ts.map