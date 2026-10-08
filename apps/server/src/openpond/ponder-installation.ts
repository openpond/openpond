import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

type StoredInstallation = {
  version: 1;
  installationId: string;
  publicKey: string;
  privateKey: string;
};

export type PonderInstallation = {
  installationId: string;
  publicKey: string;
  sign: (message: string) => string;
};

function decodeInstallation(value: unknown): StoredInstallation {
  if (!value || typeof value !== "object") throw new Error("ponder_installation_invalid");
  const record = value as Partial<StoredInstallation>;
  if (record.version !== 1 || typeof record.installationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.installationId)
    || typeof record.privateKey !== "string" || typeof record.publicKey !== "string") {
    throw new Error("ponder_installation_invalid");
  }
  const privateKey = createPrivateKey(record.privateKey);
  const publicKey = createPublicKey(record.publicKey);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519"
    || createPublicKey(privateKey).export({ type: "spki", format: "pem" }) !== record.publicKey) {
    throw new Error("ponder_installation_key_mismatch");
  }
  return record as StoredInstallation;
}

/** Private signing material stays in the server; a corrupt identity requires explicit repair. */
export async function loadPonderInstallation(storeDir: string): Promise<PonderInstallation> {
  const directory = path.join(storeDir, "ponder-installation");
  const file = path.join(directory, "identity.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const keys = generateKeyPairSync("ed25519");
    const generated: StoredInstallation = {
      version: 1,
      installationId: randomUUID(),
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(generated));
        await handle.sync();
      } finally { await handle.close(); }
      // Publish a complete file without replacing another process's winning identity.
      try { await link(temporary, file); } catch (publicationError) {
        if ((publicationError as NodeJS.ErrnoException).code !== "EEXIST") throw publicationError;
      }
      const directoryHandle = await open(directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } finally {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ponder_installation_file_invalid");
  await chmod(file, 0o600);
  const stored = decodeInstallation(JSON.parse(await readFile(file, "utf8")));
  const privateKey = createPrivateKey(stored.privateKey);
  return {
    installationId: stored.installationId,
    publicKey: stored.publicKey,
    sign: message => sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
  };
}
