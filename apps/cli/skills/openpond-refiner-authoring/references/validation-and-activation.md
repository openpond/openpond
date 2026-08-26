# Validation and activation

`refiner_profile_update` validates the complete JSON profile, writes an immutable release, records the authoring skill hash, and optionally advances the active binding atomically. Invalid profiles do not produce an active release.

Activation is host policy, not a profile field. Personal explicit changes may activate immediately. Draft requests and review-gated team or production environments create a candidate release without changing the binding. Rollback creates a new transition receipt; old Work remains pinned to its original release.
