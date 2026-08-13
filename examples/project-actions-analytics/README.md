# Project Actions analytics proof

This Project proves that a website and desktop Work can use one Git-versioned business function without duplicating it in the harness.

- `packages/domain/analytics.ts` owns the business logic.
- `apps/web/analytics.ts` is the website caller.
- `openpond/actions/analytics.ts` exposes the same function to Work.

Run the local proof from the OpenPond repository root:

```sh
pnpm openpond actions check --cwd examples/project-actions-analytics
pnpm openpond actions run analytics.get_summary --cwd examples/project-actions-analytics --input '{"businessId":"relocation"}'
```
