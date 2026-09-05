export function isolatedOpenPondEnvironment(appHome: string): NodeJS.ProcessEnv {
  return { OPENPOND_HOME: appHome };
}
