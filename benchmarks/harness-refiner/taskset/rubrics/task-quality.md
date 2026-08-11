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
6. For a direct prose deliverable such as an email, chat message, or support
   reply, require the complete send-ready copy in the user-visible response. A
   file path, completion claim, summary, or requirements checklist is not the
   requested message and fails the task when it substitutes for the actual
   copy. A short framing line, Markdown separator, or word-count note may
   coexist with a complete inline message and must not by itself cause a fail.
7. Return a pass/fail decision, a score from 0 to 1, and short evidence tied to
   the expected outcome. Do not reveal privileged criteria to the agent.
