// npm audit signatures verifies the signatures first. These checks bind that
// verified immutable package to the artifact and source approved by this run.
export function requireStableMaster(ref) {
  if (ref !== "refs/heads/master") throw new Error("Stable releases require refs/heads/master.");
}
export function requireCurrentVersion(version, latest) {
  const parts = (value) => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid stable version: ${value}`);
    return value.split(".").map(BigInt);
  };
  const wanted = parts(version);
  if (!latest) return;
  const current = parts(latest);
  const difference = wanted.findIndex((value, index) => value !== current[index]);
  if (difference >= 0 && wanted[difference] < current[difference]) throw new Error(`Refusing to downgrade npm latest from ${latest} to ${version}.`);
}
export function requirePublishedIdentity(metadata, attestations, expected) {
  if (metadata.name !== "openpond" || metadata.version !== expected.version || metadata.dist?.integrity !== expected.integrity) {
    throw new Error("Published CLI artifact does not match this release artifact.");
  }
  const provenance = attestations.attestations?.find((item) => item.predicateType === "https://slsa.dev/provenance/v1");
  const envelope = provenance?.bundle?.dsseEnvelope;
  if (envelope?.payloadType !== "application/vnd.in-toto+json") throw new Error("CLI source provenance is missing.");
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  const digest = Buffer.from(expected.integrity.replace(/^sha512-/, ""), "base64").toString("hex");
  const definition = statement.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const repository = `https://github.com/${expected.repository}`;
  if (statement.predicateType !== "https://slsa.dev/provenance/v1"
    || !statement.subject?.some((item) => item.name === `pkg:npm/openpond@${expected.version}` && item.digest?.sha512 === digest)
    || workflow?.repository !== repository || workflow?.ref !== "refs/heads/master"
    || workflow?.path !== ".github/workflows/release-builds.yml"
    || !definition.resolvedDependencies?.some((item) => item.uri === `git+${repository}@refs/heads/master` && item.digest?.gitCommit === expected.sha)) {
    throw new Error("Published CLI provenance does not match the approved release source.");
  }
}
export function requireReleaseIdentity(tagSha, release, expected) {
  if (tagSha !== expected.sha) throw new Error(`CLI tag ${expected.tag} points to another source.`);
  if (release && (release.tag_name !== expected.tag || release.draft || release.prerelease)) throw new Error("Existing CLI release has incompatible metadata.");
}
