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

## Connect an application

In the task format, open **Connect an application** and create a source credential.
Copy it into the application's secret store before closing the panel. Credentials
expire within 90 days and can be revoked from the same panel. The list contains
metadata and key prefixes only; hosts store secret hashes.

Use that credential as `OPENPOND_API_KEY` in the examples above. It authorizes
`submitExample`, `submitFeedback` and `sourceConfiguration(sourceId)` for exactly
one source and scope. Configuration returns the source and task-definition
references, allowed splits and enabled status. It does not expose private
evidence. Reading resources, grading, review, publication, training and credential
management require the owning user's authenticated client.

Owners can also manage credentials through the SDK:

```ts
import { createSourceCredentialRequest } from "openpond-sdk/learning";

const request = createSourceCredentialRequest({
  sourceId,
  name: "Application intake",
  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
});
const issued = await ownerClient.createSourceCredential(request);
// Store issued.apiKey securely. Never log it or commit the prepared request.
const page = await ownerClient.listSourceCredentials(sourceId, { limit: 30 });
await ownerClient.revokeSourceCredential(sourceId, issued.credential.id);
```

Keep the prepared request in memory for a transport retry: the same operation ID
and content returns the same credential, while changed content conflicts.
Revocation is idempotent; repeating creation does not reactivate a revoked key.
Use a new prepared request for a new credential. Disabling a source also prevents
new evidence submission. Hosts enforce authentication, expiry and source scope
on every request.

## Publish a reviewed batch to a hosted model

Call `learning.publishBatch({ batchId, modelProjectId })` against the hosted API after sealing an approved batch. This stores its immutable Taskset package and attaches the exact release to the model. It does not start training. The service authorizes the model and batch in the same team and deduplicates publication by release identity.

Model configuration can save `trainingSetup.rewardBindingRef` before selecting a Taskset. The reference pins a binding ID, revision and content hash; task compatibility and training readiness remain separate checks. Use `createModelProjectSaveRequest` with `createModelProjectsClient().checkConfiguration()` / `.saveConfiguration()` for hosted configuration operations, and `configurationCandidates()` for available starting models. Keep one request identity for transport retries.
