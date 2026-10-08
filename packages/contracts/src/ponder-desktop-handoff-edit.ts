import { z } from "zod";
import {
  PonderDesktopIntentSchema,
  PonderDesktopTargetSchema,
  PonderDesktopCatalogCursorSchema,
} from "./ponder-desktop.js";

export const PonderDesktopHandoffEditContextSchema = z
  .object({
    handoffId: z.string().min(1),
    revision: z.number().int().positive(),
    successor: z.union([
      PonderDesktopIntentSchema.options[0],
      PonderDesktopIntentSchema.options[1],
    ]),
    successCriteria: z.string().trim().min(1).max(4_000),
    targets: PonderDesktopTargetSchema.array().max(100),
    nextCursor: PonderDesktopCatalogCursorSchema.nullable(),
  })
  .strict();
export type PonderDesktopHandoffEditContext = z.infer<typeof PonderDesktopHandoffEditContextSchema>;
