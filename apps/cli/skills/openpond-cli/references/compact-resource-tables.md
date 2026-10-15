# Compact inline resource presentation

The composer’s Training picker selects the persistent Experiment or Model context. The right sidebar holds dataset rows, graders, saved results and training actions. Inline responses explain the current work; they do not need to duplicate that inventory.

Simple read-only answers normally need prose only. Do not republish resource cards for every dataset or grader read. Creation, edits, completed checks and run results can produce saved receipts; related dataset and grader receipts should share one collapsed inspection entry.

Choose the presentation that helps the request: a short sentence, a small HTML summary card, or a compact table when comparing or choosing records. No mandatory HTML template, fixed tabs or all-resources dashboard. A run-start card can show the run name, a brief state and a relevant supported action while its canonical reference also remains attached to the chat.

Keep cards slim: one short header, minimal content, useful working actions, and secondary actions in an overflow menu. Do not expose raw IDs or repeat metadata as badge strips. For saved-record collections, use a simple table rather than stacked cards. If a table needs a title and actions, place them in its first header row, inside the table.

Publish real HTML through the existing host preview/render capability. Mark resource cards or tables with `data-openpond-resource-table` to retain live inline interaction. Use semantic theme variables and escape inserted data. The marker is a rendering hint, not an attachment: use canonical CLI operations for attachment.

Only offer actions supported by the host. Dataset Select uses `data-openpond-resource-kind="dataset"`, `data-openpond-resource-id="<exact-id>"` and `data-openpond-resource-revision="<revision>"`; experiment selection uses kind `experiment`. Local filters and tabs may operate on fetched content. Do not invent API scripts or fake buttons. Use the composer for actions without an inline host bridge.

Use actual saved values. Do not present unavailable cost as zero, a mean score as pass rate, or a running training job as a completed model. Keep prose brief and avoid repeating the card as a list.

Default to one compact result: dataset name, score or progress, and one relevant action. Do not add a chart plus a table plus a saved-input section for the same result. Show tables only when useful to the requested inspection or selection, with at most five visible body rows and local pagination (Show more) for the rest. Use tight cell padding, short labels and no repeated description beneath the name. Keep IDs, hashes, exact input pins and technical metadata in Details or the supported inspector. Keep primary labels to one or two action words (Run, Train, Improve, Add grader); use familiar icons with accessible labels for expand, download and overflow. The resource sidebar owns persistent configuration; do not duplicate it inline.
