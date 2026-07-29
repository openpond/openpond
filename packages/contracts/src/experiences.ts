import { z } from "zod";

export const ExperienceSchema = z.enum(["chat", "work", "development"]);

export type Experience = z.infer<typeof ExperienceSchema>;

/**
 * Existing OpenPond sessions were created with the Development capability
 * surface. Callers creating new user-facing sessions should always send an
 * explicit experience.
 */
export const DEFAULT_SESSION_EXPERIENCE: Experience = "development";
