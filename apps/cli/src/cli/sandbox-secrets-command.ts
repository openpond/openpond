import type { OpenPondSandboxClient } from "../sandbox/client";
import {
  parseBooleanOption,
  readSandboxSecretValue,
  summarizeSandboxSecret,
} from "./common";

export async function handleSandboxSecretsCommand(
  client: OpenPondSandboxClient,
  subcommand: string,
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<boolean> {
  if (subcommand === "secrets" || subcommand === "secret-list") {
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const secrets = await client.listSecrets({
      ...(teamId ? { teamId } : {}),
    });
    if (parseBooleanOption(options.json)) {
      console.log(
        JSON.stringify(
          { secrets: secrets.map(summarizeSandboxSecret) },
          null,
          2
        )
      );
      return true;
    }
    if (secrets.length === 0) {
      console.log("no sandbox secrets found");
      return true;
    }
    for (const secret of secrets) {
      console.log(
        `${secret.name}\t${secret.status}\tv${
          secret.currentVersion ?? "current"
        }\t${secret.secretRef}`
      );
    }
    return true;
  }

  if (subcommand === "secret-create") {
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const name = typeof options.name === "string" ? options.name.trim() : "";
    const description =
      typeof options.description === "string" && options.description.trim()
        ? options.description.trim()
        : undefined;
    const scope =
      options.scope === "project" ||
      options.scope === "template" ||
      options.scope === "team"
        ? options.scope
        : undefined;
    if (!name) {
      throw new Error(
        "usage: sandbox secret-create --name <ENV_NAME> [--team-id <id>] [--stdin]"
      );
    }
    const value = await readSandboxSecretValue(options, `Value for ${name}`);
    const secret = await client.createSecret({
      ...(teamId ? { teamId } : {}),
      name,
      value,
      ...(description ? { description } : {}),
      ...(scope ? { scope } : {}),
    });
    console.log(
      JSON.stringify({ secret: summarizeSandboxSecret(secret) }, null, 2)
    );
    return true;
  }

  if (subcommand === "secret-rotate") {
    const secretId = rest[1];
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    if (!secretId) {
      throw new Error(
        "usage: sandbox secret-rotate <secretId> [--team-id <id>] [--stdin]"
      );
    }
    const value = await readSandboxSecretValue(options, "New secret value");
    const secret = await client.rotateSecret(secretId, {
      ...(teamId ? { teamId } : {}),
      value,
    });
    console.log(
      JSON.stringify({ secret: summarizeSandboxSecret(secret) }, null, 2)
    );
    return true;
  }

  if (subcommand === "secret-attach") {
    const secretId = rest[1];
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const envName =
      typeof options.envName === "string" ? options.envName.trim() : "";
    const targetType =
      options.targetType === "sandbox" ||
      options.targetType === "template" ||
      options.targetType === "project" ||
      options.targetType === "agent" ||
      options.targetType === "replay"
        ? options.targetType
        : undefined;
    const targetId =
      typeof options.targetId === "string" ? options.targetId.trim() : "";
    if (!secretId || !envName || !targetType || !targetId) {
      throw new Error(
        "usage: sandbox secret-attach <secretId> --env-name <ENV_NAME> --target-type sandbox|project|agent|template|replay --target-id <id>"
      );
    }
    const secret = await client.attachSecret(secretId, {
      ...(teamId ? { teamId } : {}),
      envName,
      targetType,
      targetId,
    });
    console.log(
      JSON.stringify({ secret: summarizeSandboxSecret(secret) }, null, 2)
    );
    return true;
  }

  if (subcommand === "secret-revoke" || subcommand === "secret-delete") {
    const secretId = rest[1];
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    if (!secretId) {
      throw new Error(
        `usage: sandbox ${subcommand} <secretId> [--team-id <id>]`
      );
    }
    const secret =
      subcommand === "secret-revoke"
        ? await client.revokeSecret(secretId, {
            ...(teamId ? { teamId } : {}),
          })
        : await client.deleteSecret(secretId, {
            ...(teamId ? { teamId } : {}),
          });
    console.log(
      JSON.stringify({ secret: summarizeSandboxSecret(secret) }, null, 2)
    );
    return true;
  }

  return false;
}
