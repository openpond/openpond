/** Windows PowerShell must resolve its own modules when launched from PowerShell 7. */
export function windowsPowerShellEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  return env;
}
