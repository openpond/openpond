# Harness Refiner benchmark task-quality rubric

Evaluate only the user-visible result and declared artifacts against the task's
privileged expected outcome.

1. Treat every `mustInclude` item as required. A materially missing or invented
   fact fails the task.
2. Treat every `mustNot` item as a hard prohibition.
3. When a task requests current research, require direct source links, relevant
   dates, and explicit uncertainty or access limitations. Prefer primary sources
   when the expected outcome calls for them.
4. When a task requests an artifact, require the requested format, a readable
   artifact, and the declared structural or visual validation. A textual claim
   that validation happened is not a substitute for a validation receipt.
5. Do not reward verbosity, extra searches, or extra tool calls. Concision is
   preferred once all requirements are satisfied.
6. Return a pass/fail decision, a score from 0 to 1, and short evidence tied to
   the expected outcome. Do not reveal privileged criteria to the agent.
