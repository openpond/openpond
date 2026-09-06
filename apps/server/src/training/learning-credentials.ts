import { createHash } from "node:crypto";
import { contentHash } from "@openpond/harness";
import { LearningDomainError, learningRef, type LearningSource } from "@openpond/evals/learning";
import { LearningSourceCredentialRequestSchema, LearningSourceConfigurationRequestSchema, LearningSourceConfigurationSchema, LearningSourceCredentialSecretSchema, assertLearningCredentialExpiry, type LearningSourceCredential } from "openpond-sdk/learning";
import type { SqliteLearningStore } from "../store/store-learning.js";

export class LearningCredentialAuthenticationError extends Error {
  readonly status = 401;
  readonly code = "learning_credential_invalid";
  constructor() { super("Source credential is invalid, revoked or expired."); this.name = "LearningCredentialAuthenticationError"; }
}

export function createLocalLearningCredentials(store: SqliteLearningStore, readSource: (scope: string, id: string) => Promise<LearningSource>) {
  async function sourceConfiguration(raw: unknown, credential?: LearningSourceCredential) {
    const input = LearningSourceConfigurationRequestSchema.parse(raw);
    if (credential && (credential.scope !== input.scope || credential.sourceId !== input.sourceId)) throw new LearningDomainError("learning_source_not_authorized", 403);
    const source = await readSource(input.scope, input.sourceId);
    return LearningSourceConfigurationSchema.parse({ scope: input.scope, source: learningRef(source), taskDefinition: source.taskDefinition, enabled: source.enabled, allowedSplits: source.allowedSplits });
  }
  return {
    sourceConfiguration,
    async manage(raw: unknown) {
      const input = LearningSourceCredentialRequestSchema.parse(raw);
      const source = await readSource(input.scope, input.sourceId);
      if (input.action === "list") return store.listLearningSourceCredentials(input.scope, input.sourceId, input.limit, input.afterId);
      if (input.action === "revoke") {
        const result = await store.revokeLearningSourceCredential(input.scope, input.sourceId, input.id, new Date().toISOString());
        if (!result) throw new LearningDomainError("learning_credential_not_found", 404);
        return result;
      }
      if (!source.enabled) throw new LearningDomainError("learning_source_disabled", 409);
      const now = new Date();
      try { assertLearningCredentialExpiry(input.expiresAt, now); }
      catch { throw new LearningDomainError("learning_credential_expiry_invalid", 400, "Source credentials must expire within 90 days."); }
      const apiKey = input.apiKey;
      const credential: LearningSourceCredential = {
        id: `credential-${contentHash([input.scope, input.operationId])}`, scope: input.scope, sourceId: input.sourceId, name: input.name,
        keyPrefix: apiKey.slice(0, apiKey.lastIndexOf("_")), createdAt: now.toISOString(), expiresAt: new Date(input.expiresAt).toISOString(), revokedAt: null,
      };
      const saved = await store.createLearningSourceCredential(credential, tokenHash(apiKey), contentHash(input));
      return { credential: saved, apiKey };
    },
    async authenticate(apiKey: string) {
      if (!LearningSourceCredentialSecretSchema.safeParse(apiKey).success) throw new LearningCredentialAuthenticationError();
      const credential = await store.findLearningSourceCredential(tokenHash(apiKey));
      if (!credential || credential.revokedAt !== null || Date.parse(credential.expiresAt) <= Date.now()) throw new LearningCredentialAuthenticationError();
      return credential;
    },
  };
}

function tokenHash(value: string) { return createHash("sha256").update(value).digest("hex"); }
