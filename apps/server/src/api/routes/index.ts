import type { HttpRouteModule } from "../http-route-types.js";
import { handleCoreRoutes } from "./core-routes.js";
import { handleEventRoutes } from "./event-routes.js";
import { handleOrganizationRoutes } from "./organization-routes.js";
import { handleProjectCloudRoutes } from "./project-cloud-routes.js";
import { handleSandboxRoutes } from "./sandbox-routes.js";
import { handleSessionRoutes } from "./session-routes.js";
import { handleSettingsRoutes } from "./settings-routes.js";
import { handleWorkspaceRoutes } from "./workspace-routes.js";

export const AUTHENTICATED_ROUTE_TABLE: HttpRouteModule[] = [
  { id: "events", handle: handleEventRoutes },
  { id: "core", handle: handleCoreRoutes },
  { id: "organizations", handle: handleOrganizationRoutes },
  { id: "sandbox", handle: handleSandboxRoutes },
  { id: "projects-cloud", handle: handleProjectCloudRoutes },
  { id: "settings-providers", handle: handleSettingsRoutes },
  { id: "workspace", handle: handleWorkspaceRoutes },
  { id: "sessions", handle: handleSessionRoutes },
];
