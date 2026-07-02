import { sandboxCatalogApi } from "./catalog-api";
import { sandboxFileApi } from "./file-api";
import { sandboxGitApi } from "./git-api";
import { sandboxIntegrationApi } from "./integration-api";
import { sandboxProjectApi } from "./project-api";
import { sandboxReplayApi } from "./replay-api";
import { sandboxRuntimeApi } from "./runtime-api";
import { sandboxTemplateApi } from "./template-api";

export const sandboxApi = {
  ...sandboxCatalogApi,
  ...sandboxReplayApi,
  ...sandboxTemplateApi,
  ...sandboxIntegrationApi,
  ...sandboxProjectApi,
  ...sandboxRuntimeApi,
  ...sandboxGitApi,
  ...sandboxFileApi,
};
