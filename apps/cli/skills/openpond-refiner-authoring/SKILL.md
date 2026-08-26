---
name: openpond-refiner-authoring
description: Inspect, extend, validate, activate, or roll back the OpenPond Refiner Review Profile. Use when invoked as $openpond-refiner-authoring or for ordinary requests to change what the Refiner emphasizes or understands.
---

# OpenPond Refiner Authoring

Update the separately versioned Review Profile through a normal Work turn. The active Refiner never edits itself during trace review.

Invoke this Skill explicitly with `$openpond-refiner-authoring` followed by the requested change. It uses the same profile-skill loading path as every other shipped Skill; it is not a slash command or a separate authoring mode.

## Workflow

1. Call `refiner_profile_inspect` before proposing any change.
2. Preserve the profile identity and unrelated instructions. Increment `version` for a changed profile.
3. Translate the user's request into the smallest clear instruction, objective change, or route restriction. Do not invent a severity taxonomy or new schema field.
4. Call `refiner_profile_update` with the complete profile and a specific reason.
5. Set `activate` to `true` for an explicit imperative change in a personal workspace. Set it to `false` when the user asks for a draft or when host policy requires review.
6. Report the old and new release hashes, the exact instruction-level change, validation, and activation state.

Read [Review Profile contract](references/review-profile.md), [Core boundary](references/core-boundary.md), and [validation and activation](references/validation-and-activation.md) before updating.

## Rules

- Use `refiner_profile_*` tools; do not guess or directly edit app-data paths.
- The Review Profile may specialize objective, instructions, and allowed routes. It may not weaken Core evidence admission, privacy, ownership, validation, or activation rules.
- Keep instructions behavioral and reusable. Do not copy customer data, raw traces, credentials, task answers, or one-off facts.
- Do not modify Harness source as a substitute for changing the Refiner.
- Do not claim activation until the returned binding points at the new release.
