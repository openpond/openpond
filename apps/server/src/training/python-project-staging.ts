import {
  copyFile,
  cp,
  mkdir,
} from "node:fs/promises";
import path from "node:path";

export async function materializeRemotePythonProject(input: {
  sourceDirectory: string;
  artifactRoot: string;
}): Promise<string> {
  const destination = path.join(
    input.artifactRoot,
    "remote",
    "openpond-training",
  );
  await mkdir(destination, {
    recursive: true,
    mode: 0o700,
  });
  await Promise.all([
    copyFile(
      path.join(input.sourceDirectory, "pyproject.toml"),
      path.join(destination, "pyproject.toml"),
    ),
    copyFile(
      path.join(input.sourceDirectory, "uv.lock"),
      path.join(destination, "uv.lock"),
    ),
    cp(path.join(input.sourceDirectory, "src"), path.join(destination, "src"), {
      recursive: true,
      force: true,
    }),
  ]);
  return destination;
}
