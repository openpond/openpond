import { sandboxFileApi } from "./file-api";
import { sandboxGitApi } from "./git-api";
import { sandboxIntegrationApi } from "./integration-api";
import { sandboxProjectApi } from "./project-api";
import { sandboxRuntimeApi } from "./runtime-api";

export const sandboxApi = {
  ...sandboxIntegrationApi,
  ...sandboxProjectApi,
  ...sandboxRuntimeApi,
  ...sandboxGitApi,
  ...sandboxFileApi,
};
