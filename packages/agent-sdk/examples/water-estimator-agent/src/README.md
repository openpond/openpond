# Source Implementation Boundary

In a real migration, the existing implementation files from `/home/glu/Projects/all/openpond-cloud-water-estimator-example/src` would remain under `src/`:

- `generate-task-plan.ts`
- `generate-estimate.ts`
- `render-drawings.ts`
- `task-plan-history.ts`
- `task-plan-ledger.ts`
- `task-plan-revisions.ts`
- `xlsx-writer.ts`

The SDK conversion should not rewrite those workflows first. It should add:

```text
agent/agent.ts
agent/actions.ts
agent/workflows/*
agent/channels/*
agent/evals/*
agent/schedules/*
```

The SDK-native action entrypoints live in `agent/actions.ts`. If today's OpenPond runtime still needs command-shaped actions, `openpond agent build` should generate that bridge internally. Users should not hand-author `src/actions/*.ts` files just to expose SDK actions.
