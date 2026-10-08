import type {
  SubagentRun, TaskInboxSnapshot, TaskInput, TaskInputAdmission,
  TaskInputMutation, TaskWait,
} from "@openpond/contracts";

/** Transactional inbox port shared by the local SQLite and hosted implementations. */
export interface TaskInboxRepository {
  recoverTaskInboxOwners(ownerId: string): Promise<Array<{ sessionId: string; turnId: string }>>;
  hasTaskCompletion(turnId: string): Promise<boolean>;
  taskInboxSnapshot(sessionId: string): Promise<TaskInboxSnapshot>;
  declareTaskWork(sessionId: string, turnId: string, ownerId: string, areas: string[]): Promise<void>;
  taskWorkAreas(sessionId: string): Promise<string[]>;
  admitTaskInput(input: TaskInputAdmission): Promise<TaskInput>;
  admitTaskInputs(inputs: TaskInputAdmission[]): Promise<TaskInput[]>;
  rejectTaskInput(id: string, error: string, executionTurnId?: string): Promise<void>;
  getTaskInput(id: string): Promise<TaskInput | null>;
  taskInputsForSession(sessionId: string, query?: { afterSequence?: number; pendingOnly?: boolean; limit?: number }): Promise<TaskInput[]>;
  mutateTaskInput(sessionId: string, inputId: string, change: TaskInputMutation): Promise<TaskInput>;
  openTaskInboxTurn(sessionId: string, turnId: string, ownerId: string): Promise<void>;
  renewTaskInboxTurn(sessionId: string, turnId: string, ownerId: string): Promise<void>;
  pendingTaskInputs(sessionId: string, turnId: string): Promise<TaskInput[]>;
  taskAssignmentInputs(turnId: string): Promise<TaskInput[]>;
  pauseTaskInboxTurn(sessionId: string, turnId: string, ownerId: string): Promise<void>;
  includeTaskInputs(sessionId: string, turnId: string, ownerId: string, requestId: string): Promise<TaskInput[]>;
  settleTaskInputRequest(requestId: string, outcome: "resolved" | "failed" | "replaced"): Promise<void>;
  sealTaskInboxTurn(sessionId: string, turnId: string, ownerId: string): Promise<boolean>;
  sealNativeTaskInboxTurn(sessionId: string, turnId: string, ownerId: string): Promise<TaskInput[]>;
  closeTaskInboxTurn(sessionId: string, turnId: string, ownerId: string, outcome: "completed" | "failed" | "interrupted"): Promise<void>;
  taskInboxPaused(sessionId: string): Promise<boolean>;
  reserveTaskFollowup(sessionId: string, turnId: string, ownerId: string): Promise<TaskInput | null>;
  taskInboxWakeTargets(): Promise<string[]>;
  createTaskWait(value: TaskWait): Promise<TaskWait>;
  settleTaskWait(id: string, state: TaskWait["state"]): Promise<TaskWait>;
  taskWaitsForSession(sessionId: string): Promise<TaskWait[]>;
  commitSubagentCompletion(value: SubagentRun, turnId: string): Promise<void>;
  pendingTaskCompletions(afterTurnId?: string): Promise<Array<{ turnId: string; run: SubagentRun }>>;
  settleTaskCompletion(turnId: string, inputId: string): Promise<void>;
}
