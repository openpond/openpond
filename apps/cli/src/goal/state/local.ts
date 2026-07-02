import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CreatePipelineSnapshotSchema } from "@openpond/contracts";

import type { GoalStateAdapter } from "./adapter";
import { serializeGoalEventRecord } from "../events";
import {
  assertGoalEventRecord,
  assertGoalQuestionSnapshot,
  assertGoalRunResultRecord,
} from "../schemas";
import type {
  GoalAnswer,
  GoalEvent,
  GoalQuestion,
  GoalRunResult,
  GoalState,
} from "../types";

const GOAL_STATE_FILE = "state.json";
const GOAL_EVENTS_FILE = "events.jsonl";
const GOAL_QUESTIONS_FILE = "questions.json";
const GOAL_RESULT_FILE = "result.json";
const CREATE_PIPELINE_FILE = "create-pipeline.json";
const CREATE_PLAN_FILE = "create-plan.json";
const WORKFLOW_CAPTURE_FILE = "workflow-capture.json";

export class LocalGoalStateAdapter implements GoalStateAdapter {
  constructor(private readonly storageRoot: string) {}

  async create(goal: GoalState): Promise<GoalState> {
    await this.write(goal);
    return goal;
  }

  async get(goalId: string): Promise<GoalState | null> {
    try {
      const raw = await readFile(this.goalStatePath(goalId), "utf-8");
      return JSON.parse(raw) as GoalState;
    } catch {
      return null;
    }
  }

  async findGoalByQuestionId(questionId: string): Promise<GoalState | null> {
    const root = this.goalRoot();
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const goal = await this.get(entry);
      if (goal?.questions.some((question) => question.id === questionId)) {
        return goal;
      }
    }
    return null;
  }

  async update(goal: GoalState): Promise<GoalState> {
    const next = { ...goal, updatedAt: new Date().toISOString() };
    await this.write(next);
    return next;
  }

  async appendEvent(goalId: string, event: GoalEvent): Promise<GoalState> {
    const goal = await this.requireGoal(goalId);
    const next = {
      ...goal,
      events: [...goal.events, event],
      updatedAt: new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }

  async addQuestion(
    goalId: string,
    question: GoalQuestion
  ): Promise<GoalState> {
    const goal = await this.requireGoal(goalId);
    const now = new Date().toISOString();
    const createPipeline = goal.createPipeline
      ? CreatePipelineSnapshotSchema.parse({
          ...goal.createPipeline,
          state: question.required ? "awaiting_questions" : goal.createPipeline.state,
          questionIds: Array.from(
            new Set([...(goal.createPipeline.questionIds ?? []), question.id]),
          ),
          updatedAt: now,
        })
      : undefined;
    const next = {
      ...goal,
      status: question.required ? "awaiting_user_input" : goal.status,
      questions: [...goal.questions, question],
      ...(createPipeline ? { createPipeline } : {}),
      updatedAt: now,
    };
    await this.write(next);
    return next;
  }

  async answerQuestion(params: {
    goalId: string;
    questionId: string;
    answer: GoalAnswer;
  }): Promise<GoalState> {
    const goal = await this.requireGoal(params.goalId);
    const now = new Date().toISOString();
    const questions = goal.questions.map((question) =>
      question.id === params.questionId
        ? { ...question, answeredAt: now }
        : question
    );
    const hasOpenRequiredQuestion = questions.some(
      (question) => question.required && !question.answeredAt
    );
    const createPipeline =
      goal.createPipeline && goal.createPipeline.state === "awaiting_questions" && !hasOpenRequiredQuestion
        ? CreatePipelineSnapshotSchema.parse({
            ...goal.createPipeline,
            state: goal.createPipeline.plan?.status === "pending_approval"
              ? "awaiting_plan_approval"
              : "planning",
            updatedAt: now,
          })
        : goal.createPipeline;
    const next = {
      ...goal,
      status:
        goal.status === "awaiting_user_input" && !hasOpenRequiredQuestion
          ? "queued"
          : goal.status,
      questions,
      answers: [...goal.answers, params.answer],
      ...(createPipeline ? { createPipeline } : {}),
      updatedAt: now,
    };
    await this.write(next);
    return next;
  }

  async writeResult(goalId: string, result: GoalRunResult): Promise<void> {
    await mkdir(this.goalDir(goalId), { recursive: true });
    const validated = assertGoalRunResultRecord(result);
    await writeFile(
      this.goalResultPath(goalId),
      `${JSON.stringify(validated, null, 2)}\n`,
      "utf-8"
    );
  }

  private async requireGoal(goalId: string): Promise<GoalState> {
    const goal = await this.get(goalId);
    if (!goal) throw new Error(`goal not found: ${goalId}`);
    return goal;
  }

  private goalRoot(): string {
    return join(this.storageRoot, ".openpond", "goals");
  }

  private goalDir(goalId: string): string {
    return join(this.goalRoot(), goalId);
  }

  private goalStatePath(goalId: string): string {
    return join(this.goalDir(goalId), GOAL_STATE_FILE);
  }

  private goalEventsPath(goalId: string): string {
    return join(this.goalDir(goalId), GOAL_EVENTS_FILE);
  }

  private goalQuestionsPath(goalId: string): string {
    return join(this.goalDir(goalId), GOAL_QUESTIONS_FILE);
  }

  private goalResultPath(goalId: string): string {
    return join(this.goalDir(goalId), GOAL_RESULT_FILE);
  }

  private createPipelinePath(goalId: string): string {
    return join(this.goalDir(goalId), CREATE_PIPELINE_FILE);
  }

  private createPlanPath(goalId: string): string {
    return join(this.goalDir(goalId), CREATE_PLAN_FILE);
  }

  private workflowCapturePath(goalId: string): string {
    return join(this.goalDir(goalId), WORKFLOW_CAPTURE_FILE);
  }

  private async write(goal: GoalState): Promise<void> {
    await mkdir(this.goalDir(goal.id), { recursive: true });
    const events = goal.events.map(assertGoalEventRecord);
    const questionSnapshot = assertGoalQuestionSnapshot({
      questions: goal.questions,
      answers: goal.answers,
    });
    await writeFile(
      this.goalStatePath(goal.id),
      `${JSON.stringify(goal, null, 2)}\n`,
      "utf-8"
    );
    await writeFile(
      this.goalEventsPath(goal.id),
      events.length > 0
        ? `${events.map(serializeGoalEventRecord).join("\n")}\n`
        : "",
      "utf-8"
    );
    await writeFile(
      this.goalQuestionsPath(goal.id),
      `${JSON.stringify(questionSnapshot, null, 2)}\n`,
      "utf-8"
    );
    if (goal.createPipeline) {
      await writeFile(
        this.createPipelinePath(goal.id),
        `${JSON.stringify(goal.createPipeline, null, 2)}\n`,
        "utf-8"
      );
      if (goal.createPipeline.plan) {
        await writeFile(
          this.createPlanPath(goal.id),
          `${JSON.stringify(goal.createPipeline.plan, null, 2)}\n`,
          "utf-8"
        );
      }
      if (goal.createPipeline.workflowCapture) {
        await writeFile(
          this.workflowCapturePath(goal.id),
          `${JSON.stringify(goal.createPipeline.workflowCapture, null, 2)}\n`,
          "utf-8"
        );
      }
    }
  }
}
