import path from "node:path";

export function isolatedOpenPondEnvironment(appHome: string): NodeJS.ProcessEnv {
  return {
    OPENPOND_APP_HOME: appHome,
    OPENPOND_CONFIG_DIR: path.join(appHome, "config"),
  };
}
