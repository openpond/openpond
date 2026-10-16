import { createHash } from "node:crypto";
import type { ChatProvider, ProviderSettings } from "@openpond/contracts";
import type { ProviderSecrets } from "./provider-secrets.js";

export function ponderProviderCredential(input: {providerId:ChatProvider;settings:ProviderSettings;secrets:ProviderSecrets}): string {
  const secret=input.secrets.providers[input.providerId];
  if(!secret)throw new Error("ponder_history_provider_credential_unavailable");
  const endpoint=input.settings.providers[input.providerId]?.baseUrl ?? null;
  const identity=secret.source === "chatgpt_subscription"
    ? {source:secret.source,credentialId:secret.credentialId,accountId:secret.oauth?.accountId}
    : {source:secret.source,key:secret.source === "env" && secret.envVar ? process.env[secret.envVar] : secret.value};
  if(secret.source === "chatgpt_subscription" && (!secret.oauth || (!secret.credentialId && !secret.oauth.accountId)))throw new Error("ponder_history_provider_credential_unavailable");
  if(secret.source !== "chatgpt_subscription" && !identity.key)throw new Error("ponder_history_provider_credential_unavailable");
  return createHash("sha256").update(JSON.stringify({providerId:input.providerId,endpoint,identity})).digest("hex");
}

export function ponderHostedCredential(input:{apiBaseUrl:string;token:string}):string {
  return createHash("sha256").update(JSON.stringify({providerId:"openpond",source:"account",...input})).digest("hex");
}
