# Portable training operations

OpenPond resolves every portable Model Run into an immutable Harness Run
Manifest. The manifest pins the Harness, Dataset, Evidence Sets, Model,
Recipe, runtime, compute target, engine, worker image, approval, and resolved
bundle. Provider credentials and TLS private keys are never embedded in the
manifest or bundle.

## Shared worker release configuration

Connected and direct-provider targets require a verified signed worker catalog:

```text
OPENPOND_WORKER_CATALOG_PATH
OPENPOND_WORKER_CATALOG_PUBLIC_KEY_PATH
OPENPOND_WORKER_CATALOG_SIGNING_KEY_ID
```

The catalog loader verifies the catalog content hash, KMS signature, OpenPond
release, worker protocol, image digest, SBOM reference, image signature
reference, upstream revision, and conformance receipt before the target can
become available.

## Existing LAN or SSH worker

An already-running connected worker uses:

```text
OPENPOND_CONNECTED_WORKER_URL
OPENPOND_CONNECTED_WORKER_AUTHENTICATION_LEASE_FILE
OPENPOND_CONNECTED_WORKER_IDENTITY_KEY_FILE
OPENPOND_CONNECTED_WORKER_IMAGE_DIGEST
OPENPOND_CONNECTED_WORKER_CLIENT_CERTIFICATE_FILE
OPENPOND_CONNECTED_WORKER_CLIENT_PRIVATE_KEY_FILE
OPENPOND_CONNECTED_WORKER_SERVER_CA_FILE
```

Configuration is all-or-nothing. The endpoint must use HTTPS outside
loopback. Authentication, identity, and private-key files must be regular
non-symlink files with no group or other permissions.

## OpenPond Managed

OpenPond Managed is the hosted compute option for a portable Model Run.
OpenPond prepares an isolated per-run environment, resolves compatible
accelerator capacity, operates the training lifecycle, and preserves the
resulting artifacts and receipts.

The infrastructure and provider topology stay behind the OpenPond Managed
boundary. Users choose the method, Model, retention, and maximum spend; they
do not configure OpenPond's underlying provider credentials or placement.
The Harness Run Manifest continues to pin provider-neutral runtime and
compute capabilities so the release graph remains inspectable and portable.

## Recovery and local state

Portable release objects and manifests live below
`training/portable-releases`. Connected artifacts and provisioned compute
sessions use separate private directories below `training/`. Lifecycle
references persist the selected engine route, so status, logs, cancellation,
collection, and cleanup do not infer a provider after restart.

Selecting a Model or target has no download, upload, quote, provisioning, or
spend side effect. Those operations begin only from the top-level Run review.
A hosted GPU run still requires an explicit maximum spend for that run.
