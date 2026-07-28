import { z } from "zod";

export const TrainingIdSchema = z.string().trim().min(1).max(240);
export const TrainingTimestampSchema = z.string().trim().min(1);
export const TrainingHashSchema = z.string().trim().min(8).max(256);
export const TrainingMetadataSchema = z
  .record(z.string(), z.unknown())
  .default({});
