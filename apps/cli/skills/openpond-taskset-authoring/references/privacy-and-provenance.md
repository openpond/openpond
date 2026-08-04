# Privacy and provenance

- Require source consent before authoring and separate disclosure approval before a hosted model reads source content.
- Show the analysis provider/model, exact source scope, and whether raw or transformed evidence leaves the machine.
- Block unresolved secrets, licensing violations, hidden grader leakage, and unapproved connected-app data.
- Record source hashes, model/config, skill hash, prompt/template version, SDK version, source commit, assumptions, and repair history.
- Keep the authoring transcript separate from the typed proposal and approved materialized Taskset.
- Training export is a later approval and contains only approved transformed assets.
- For conversation-backed authoring, treat `get_conversations` as the
  complete consented-evidence boundary. Its configured scope and returned source
  references are authoritative; never request arbitrary owner, workspace,
  conversation, or watermark identifiers and never reinterpret schedule
  enablement as source consent.
- A revoked source remains identifiable in an existing receipt but must not be
  re-read or resent to a model in a later review.
