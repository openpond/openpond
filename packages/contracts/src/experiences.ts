import { z } from "zod";

export const ExperienceSchema = z.enum(["chat", "work", "development"]);

export type Experience = z.infer<typeof ExperienceSchema>;

export const ProductAreaSchema = z.enum(["chat", "models", "development"]);

export type ProductArea = z.infer<typeof ProductAreaSchema>;

/**
 * Existing OpenPond sessions were created with the Development capability
 * surface. Callers creating new user-facing sessions should always send an
 * explicit experience.
 */
export const DEFAULT_SESSION_EXPERIENCE: Experience = "work";
