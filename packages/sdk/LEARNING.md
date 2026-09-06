# Submit task evidence

Install `openpond-sdk` and use `OpenPondLearningClient` from
`openpond-sdk/learning`. Task definitions, reusable Rewards, grading, review,
batching and HTTP schemas are owned by `@openpond/evals/learning`; see that
package's `LEARNING.md` for the full contract and host responsibilities.

The runnable examples in `examples/learning` submit one JSON record through an
existing source. Create a task format and source in Models → Tasksets → Task
formats first. The sample uses an input object with `question` and an output
object with `answer`; adapt the record to your published format. The scripts read
the source's exact task-definition reference from the server.

Set `OPENPOND_API_KEY`, `OPENPOND_API_URL` and `OPENPOND_LEARNING_SCOPE` in your
shell, then run one of:

```sh
node --experimental-strip-types submit.ts SOURCE_ID example.json
python3 submit.py SOURCE_ID example.json
```

Use the URL of the execution owner: a local OpenPond server or the hosted API
where the learning service is deployed. The server authorizes the requested
profile/team scope. The SDK and Python example send the selected scope in
`X-OpenPond-Team-Id` so hosted requests select that team before authorization;
the local server uses the profile scope in the request body. These variables are example configuration, not arguments
that should be committed with credentials.

Assign stable example/attempt identities and preserve `idempotencyKey`, timestamp
and content on retries. A different record must use a different key. Submission
records evidence; it does not approve the task or observed response for training.
The failed observed answer in the sample is intentional. Grade it, propose the
correct target, grade that target separately, and approve it in Example review.

For feedback, call `client.submitFeedback` with a
`openpond.taskFeedback.v1` envelope. Preserve source/example/attempt identity,
use a separate stable idempotency key, and set `expectedEvidenceHash` to the
evidence hash when targeting a specific revision. Feedback may arrive before
the example and stays pending until review. Corrections do not mutate sealed
historical batches.

All client requests support an optional `AbortSignal`. Aborting a request does
not cancel remote compute; use `cancel_grade` and read the authoritative terminal
job state. Page through list responses with `nextCursor` as `afterId`.

## Publish a reviewed batch to a hosted model

Call `learning.publishBatch({ batchId, modelProjectId })` against the hosted API after sealing an approved batch. This stores its immutable Taskset package and attaches the exact release to the model. It does not start training. The service authorizes the model and batch in the same team and deduplicates publication by release identity.

Model configuration can save `trainingSetup.rewardBindingRef` before selecting a Taskset. The reference pins a binding ID, revision and content hash; task compatibility and training readiness remain separate checks. Use `createModelProjectSaveRequest` with `createModelProjectsClient().checkConfiguration()` / `.saveConfiguration()` for hosted configuration operations, and `configurationCandidates()` for available starting models. Keep one request identity for transport retries.
