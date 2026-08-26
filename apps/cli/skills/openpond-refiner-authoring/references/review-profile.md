# Review Profile contract

The canonical managed source is `openpond.review.json`, validated as `openpond.refinerReviewProfile.v1`.

Required fields are `schemaVersion`, `id`, `version`, `name`, `objective`, `instructions`, `allowedProposalRoutes`, and `allowedExternalRoutes`. Each instruction is `{ "id": "stable-kebab-id", "text": "A behavioral instruction." }`.

Keep the profile small. Put policy prose in instruction text instead of adding fields for every domain concept. JSON is the portable artifact; TypeScript helpers may produce the same JSON but are not the stored contract.
