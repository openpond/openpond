declare const __OPENPOND_COMPILED_CLI__: boolean;

export const IS_COMPILED_CLI =
  typeof __OPENPOND_COMPILED_CLI__ !== "undefined" && __OPENPOND_COMPILED_CLI__;
