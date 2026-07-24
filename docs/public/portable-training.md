# Portable training operations

OpenPond resolves every portable Model Run into an immutable Harness Run
Manifest. The manifest pins the Harness, Dataset, Evidence Sets, Model,
Recipe, runtime, compute target, engine, worker image, approval, and resolved
bundle. Provider credentials and TLS private keys are never embedded in the
manifest or bundle.

## Shared worker release configuration

Connected, raw Prime, and Sandbox M8 targets require a verified signed worker
catalog:

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

## Raw Prime compute

The raw Prime route provisions a qualified SSH-reachable H100 80 GB node,
then runs the same generic connected-worker protocol used by LAN and BYOC
workers. It requires:

```text
OPENPOND_PRIME_API_KEY_FILE
OPENPOND_PRIME_SSH_KEY_ID
OPENPOND_PRIME_SSH_PRIVATE_KEY_FILE
OPENPOND_PRIME_WORKER_TEMPLATE_ID
OPENPOND_PRIME_WORKER_IMAGE_REPOSITORY
OPENPOND_PRIME_WORKER_IMAGE_DIGEST
OPENPOND_PRIME_WORKER_CAPABILITY_RECEIPT
OPENPOND_PRIME_WORKER_REGISTRY_AUTH_FILE
OPENPOND_PRIME_WORKER_AUTHENTICATION_LEASE_FILE
OPENPOND_PRIME_WORKER_IDENTITY_KEY_FILE
OPENPOND_PRIME_WORKER_TLS_CERTIFICATE_FILE
OPENPOND_PRIME_WORKER_TLS_PRIVATE_KEY_FILE
OPENPOND_PRIME_WORKER_CLIENT_CA_FILE
OPENPOND_PRIME_CLIENT_CERTIFICATE_FILE
OPENPOND_PRIME_CLIENT_PRIVATE_KEY_FILE
OPENPOND_PRIME_SERVER_CA_FILE
OPENPOND_PRIME_TLS_SERVER_NAME
```

Optional settings are `OPENPOND_PRIME_API_URL`,
`OPENPOND_PRIME_WORKER_PORT` (default `8443`), and
`OPENPOND_PRIME_WORKER_RUNTIME` (`docker` by default; `podman` is also
supported).

The API key, SSH private key, registry authentication, authentication lease,
identity key, and private TLS keys must be private regular files. OpenPond
filters availability to one non-variable, non-prepaid, secure-cloud
`H100_80GB`, includes disk cost in the bounded quote, and refuses
provisioning without an explicit maximum spend. It pins the first
provider-returned SSH host key, stages secrets only over verified SSH stdin,
pulls the exact registry digest with a temporary Docker configuration, starts
the mTLS worker, and persists the provider lease and bootstrap receipt for
restart recovery. Cancellation, collection, validation failure, and
bootstrap failure all attempt worker cleanup before provider termination.

## Sandbox M8

The Sandbox route implements only the M8 portable-execution composition. It
does not reimplement or reopen Sandbox M0-M7:

```text
OPENPOND_SANDBOX_M8_URL
OPENPOND_SANDBOX_M8_AUTH_TOKEN_FILE
OPENPOND_SANDBOX_M8_COMPOSITION_FILE
```

The auth file is read for every request so a five-minute scoped `opsvc_`
service token can be rotated atomically. It must be a private regular
non-symlink file. The composition file uses
`openpond.sandboxM8Composition.v1` and contains:

- the exact isolated M8 environment value and canonical SHA-256;
- the exact GCP-control-plane/Latitude runtime placement receipt;
- the qualified provider-neutral connected-GPU binding;
- the expected signed worker digest, upstream revision, and capability
  receipt;
- the immutable Profile, Taskset, Model, environment-archive, limit, and
  connected-GPU input template.

At launch OpenPond uploads the exact environment value to the tenant-owned R2
store, uploads and materializes the immutable Harness Release, verifies the
placement receipt, obtains a qualified GPU quote, checks it against the
approved maximum, obtains an approval lease, and projects the OpenPond GRPO
Recipe into the pinned prime-rl M8 recipe. The projection carries the source
Recipe hash, so Sandbox can validate translation lineage without changing
the canonical OpenPond manifest.

## Recovery and local state

Portable release objects and manifests live below
`training/portable-releases`. Connected artifacts, provisioned compute
sessions, and Prime bootstrap receipts use separate private directories below
`training/`. Lifecycle references persist the selected engine route, so
status, logs, cancellation, collection, and cleanup do not infer a provider
after restart.

Selecting a Model or target has no download, upload, quote, provisioning, or
spend side effect. Those operations begin only from the top-level Run review.
A hosted GPU run still requires an explicit maximum spend for that run.
