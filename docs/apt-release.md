# Linux APT distribution

OpenPond's Debian package is **`openpond`**. It installs the desktop executable as
`openpond-desktop`, keeping the `openpond` command available for the npm CLI.
The nightly Debian package is `openpond-nightly`, with executable
`openpond-desktop-nightly`; only stable releases enter the APT repository.

The initial supported targets are Ubuntu 24.04 and Debian 13, on amd64 and arm64.
Release CI builds both architectures, exercises install/upgrade/removal on both
distributions, and runs the installed desktop smoke on Ubuntu. The repository
contract check uses real APT downloads on both distributions with a disposable
signing key. Other Debian derivatives are not yet part of this acceptance matrix.

## Implementation and release flow

1. `pnpm run build:artifacts` builds the application.
2. `pnpm run package:linux` stages it and produces AppImage and `.deb` artifacts.
   Release builds use `package:linux:release` after `scripts/prepare-release.ts`.
3. Release CI validates the actual installed `.deb`, then publishes both
   architectures and their `SHA256SUMS.txt` in the stable GitHub release.
4. With the repository variable `APT_ENABLED=true`, the release job calls
   `publish-apt.yml`. This runs only from `master` and uses the `apt-release`
   GitHub environment. A manual dispatch can bootstrap or retry an existing tag.
5. The publisher downloads and checks the published release's checksums, package
   names, versions and architectures before importing any signing credentials.
6. `scripts/apt/repository.py` uses `apt-ftparchive` and GnuPG to generate signed
   indexes for one complete stable version. No persistent repository database is
   needed. `verify.py` checks the signature, indexes, by-hash copies and packages.
7. `publish.py` uploads packages and indexes to a dedicated R2 bucket. `InRelease`
   is written last. Package objects and by-hash indexes are immutable; older
   objects are retained. Both manual and automatic runs share a concurrency lock.
8. `check-client.py` verifies signed APT downloads of both architectures through
   `https://apt.openpond.ai`, using the local signing public key as its trust anchor.

A `.deb` release can be built and reviewed before the production key exists.
Nothing publishes to R2 automatically until `APT_ENABLED` is enabled. There is no
production key or hosting credential in this repository.

## One-time R2 setup

Create a **dedicated** R2 bucket named `openpond-apt` and connect the public custom
domain `apt.openpond.ai` in the same Cloudflare account as the domain's zone.
Do not put private files or other applications in this bucket.

Create an R2 S3 API token with **Object Read & Write** scoped to that bucket only.
The publisher needs object listing, reads, and writes. It never deletes objects.
Record the S3 endpoint from the R2 dashboard, for example
`https://<account-id>.r2.cloudflarestorage.com`.

Configure caching to honor origin `Cache-Control`. The publisher gives mutable
metadata `no-cache,max-age=0,must-revalidate` and immutable objects a long cache
lifetime. Do not override that with a blanket cache rule. APT traffic must not
receive login redirects or browser challenges. Disable the development `r2.dev`
URL; the production custom domain is sufficient. Do not apply automatic deletion
lifecycle rules to package or by-hash objects.

References: [public custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/),
[R2 with the AWS CLI](https://developers.cloudflare.com/r2/examples/aws/aws-cli/).

## Owner action: create the production signing key

Do this on your trusted machine, outside CI. Keep the primary private key, its
passphrase and revocation certificate in a secure offline backup. CI receives
only the signing subkey. **Do not paste a private key or passphrase into chat.**

Create a primary certification key and a signing subkey:

```bash
gpg --quick-generate-key 'OpenPond APT <sam@openpond.ai>' rsa4096 cert 2y
gpg --list-secret-keys --keyid-format long 'OpenPond APT'
```

Copy the full **primary** fingerprint into the following variable, then add the
subkey. GnuPG will prompt for the key's passphrase:

```bash
APT_FINGERPRINT='REPLACE_WITH_FULL_UPPERCASE_PRIMARY_FINGERPRINT'
gpg --quick-add-key "$APT_FINGERPRINT" rsa4096 sign 1y
```

Create the GitHub environment `apt-release`, restrict its deployment branches to
`master`, and configure these **environment variables**:

| Variable | Value |
| --- | --- |
| `APT_R2_BUCKET` | `openpond-apt` |
| `APT_R2_ENDPOINT` | The bucket account's HTTPS S3 endpoint |
| `APT_SIGNING_FINGERPRINT` | Full uppercase primary fingerprint |

Configure these **environment secrets**:

| Secret | Value |
| --- | --- |
| `APT_SIGNING_PRIVATE_KEY` | ASCII-armored secret signing subkey export |
| `APT_SIGNING_PASSPHRASE` | The subkey's passphrase |
| `APT_R2_ACCESS_KEY_ID` | Bucket-scoped R2 access key ID |
| `APT_R2_SECRET_ACCESS_KEY` | Matching secret access key |

For example, from this checkout with GitHub CLI authenticated:

```bash
gpg --armor --export-secret-subkeys "$APT_FINGERPRINT" \
  | gh secret set APT_SIGNING_PRIVATE_KEY --env apt-release

gh secret set APT_SIGNING_PASSPHRASE --env apt-release
gh secret set APT_R2_ACCESS_KEY_ID --env apt-release
gh secret set APT_R2_SECRET_ACCESS_KEY --env apt-release

gh variable set APT_SIGNING_FINGERPRINT --env apt-release --body "$APT_FINGERPRINT"
gh variable set APT_R2_BUCKET --env apt-release --body openpond-apt
```

Set `APT_R2_ENDPOINT` in the same environment using the actual account endpoint.
Before uploading the secret, confirm `gpg --list-secret-keys` shows your intended
primary key and signing subkey. Never upload your primary secret key using
`--export-secret-keys`.

## Activate the first release

Merge the packaging/publishing change, then create a normal stable release with
the existing `pnpm run release:patch` process. It must contain one `.deb` per
architecture. Existing AppImage-only releases cannot bootstrap this repository.

Manually dispatch the publisher with that actual stable tag (replace the example):

```bash
gh workflow run publish-apt.yml --ref master -f tag=v0.1.1
```

Wait for the public-domain APT download check to pass. Publish the key fingerprint
and installation instructions on the website, then enable automatic publication:

```bash
gh variable set APT_ENABLED --body true
```

This last variable is a **repository** variable, because the calling release
workflow evaluates it before entering the `apt-release` environment.

## User installation (after activation)

These commands require `curl` and CA certificates. Publish them only after the
first repository deployment has passed verification:

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://apt.openpond.ai/openpond.asc -o /tmp/openpond.asc
sudo install -m 0644 /tmp/openpond.asc /etc/apt/keyrings/openpond.asc
rm /tmp/openpond.asc
sudo tee /etc/apt/sources.list.d/openpond.sources >/dev/null <<'EOF'
Types: deb
URIs: https://apt.openpond.ai
Suites: stable
Components: main
Architectures: amd64 arm64
Signed-By: /etc/apt/keyrings/openpond.asc
EOF
sudo apt-get update
sudo apt-get install openpond
```

Launch OpenPond from the application menu or with `openpond-desktop`. Upgrade using
normal system package updates or `sudo apt-get install --only-upgrade openpond`.
Remove the application with `sudo apt-get remove openpond`; personal app data is
not removed by the package. APT owns updates for this installation.

[APT's signing and keyring guidance](https://manpages.debian.org/testing/apt/apt-secure.8.en.html)
explains the repository-scoped `Signed-By` configuration.

## Recovery and key maintenance

- **Interrupted publication:** retry the same tag. Existing immutable bytes are
  checked and reused. Clients holding the previous `InRelease` can still download
  its by-hash indexes and packages. A failed upload never deletes prior artifacts.
- **An older queued run:** publication refuses a version lower than the currently
  signed repository version. Do not force a downgrade to roll back application
  behavior; publish a corrected build under a higher stable version.
- **A changed build at the same version:** rejected. Release versions and their
  package bytes are immutable. Create a new stable version.
- **History:** `snapshots/<version>/<manifest-sha256>/` retains signed release
  metadata. Historical `.deb` files remain in `pool/`; the live indexes advertise
  only the current stable version.
- **Disable automatic publication:** set the repository variable `APT_ENABLED` to
  `false`. Manual publication remains available from `master`.
- **Expiry/rotation:** schedule owner maintenance before the signing subkey expires.
  The publisher deliberately refuses to silently replace `openpond.asc`, including
  an updated export of the same key. Rotation requires a reviewed key distribution
  plan for existing clients, an explicit update of the public key object, and
  matching CI credentials. Never delete the old trusted key before clients migrate.

The release metadata intentionally has no short `Valid-Until`: releases may be
infrequent and no periodic re-signing service exists. HTTPS and signed metadata
protect transport/integrity; this does not impose a time limit on replay of a
previously signed release. The signing subkey has an expiry and the publisher
rejects downgrades against the stored signed version.

## Local verification

On Linux, install `python3`, `apt-utils`, `gnupg`, `gpgv` and `dpkg`, then run:

```bash
python3 -m unittest discover -s scripts/apt -p 'test_*.py'
pnpm run workflows:check
pnpm run build:artifacts
pnpm run package:linux
```

The Python test creates and deletes a temporary signing key, serves a loopback
repository, and downloads tiny fixture packages using isolated APT state. It does
not install packages or change system sources. `smoke-deb.sh` performs actual
installation and must run only inside a disposable CI runner/container with
`CI=true`. `APT_SMOKE_DESKTOP=1` additionally runs the installed desktop harness
and requires Node, the workspace dependencies, and a display or Xvfb.
