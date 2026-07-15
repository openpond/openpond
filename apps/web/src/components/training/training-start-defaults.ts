import { recommendedTrainingSequenceLength, type Taskset } from "@openpond/contracts";

const MINIMUM_SEQUENCE_LENGTH = 64;
const MAXIMUM_SEQUENCE_LENGTH = 4096;

export function recommendedSequenceLength(taskset: Taskset): number {
  return recommendedTrainingSequenceLength(taskset, {
    minimum: MINIMUM_SEQUENCE_LENGTH,
    maximum: MAXIMUM_SEQUENCE_LENGTH,
  });
}
