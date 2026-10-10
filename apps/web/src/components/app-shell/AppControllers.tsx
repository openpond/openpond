import {
  lazy,
  Suspense,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { Sidebar } from "../sidebar/Sidebar";
import { DesktopNavigationRail } from "../sidebar/DesktopNavigationRail";
import { CloudSetupDialog } from "../workspace/CloudSetupDialog";
import { AppLazyPanels, AppSettingsRoute } from "./AppLazyPanels";
import { AppToast as AppToastView } from "./AppToast";
import { AppTopBar } from "./AppTopBar";
import { PageChromeProvider } from "./PageChrome";
import type { MainPaneProps } from "./main-pane-types";
import { ProjectConfirmDialog } from "./ProjectConfirmDialog";
import { RenderCommitBoundary } from "../../lib/render-commit-metrics";

const MainPane = lazy(() =>
  import("./MainPane").then((module) => ({ default: module.MainPane }))
);

export type AppShellControllerProps = {
  className: string;
  style: CSSProperties;
  sidebar: ComponentProps<typeof Sidebar>;
  topBar: ComponentProps<typeof AppTopBar>;
  mainPane: MainPaneProps;
  cloudSetup: ComponentProps<typeof CloudSetupDialog>;
  projectConfirm: ComponentProps<typeof ProjectConfirmDialog>;
  lazyPanels: ComponentProps<typeof AppLazyPanels>;
  toast: ComponentProps<typeof AppToastView>;
};

export function AppShellController({
  className,
  style,
  sidebar,
  topBar,
  mainPane,
  cloudSetup,
  projectConfirm,
  lazyPanels,
  toast,
}: AppShellControllerProps) {
  return (
    <PageChromeProvider>
    <div className={className} style={style}>
      <DesktopNavigationRail sidebar={sidebar} open={topBar.sidebarOpen} />
      {topBar.sidebarAvailable !== false ? <RenderCommitBoundary id="sidebar">
        <Sidebar {...sidebar} open={topBar.sidebarOpen} />
        {topBar.sidebarOpen ? (
          <div
            className="sidebar-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={sidebar.onSidebarResizeStart}
          />
        ) : null}
      </RenderCommitBoundary> : null}

      <div className="content-shell">
        <AppTopBar {...topBar} />
        <Suspense
          fallback={
            <main className="main-pane" aria-busy="true" aria-label="Loading workspace" />
          }
        >
          <MainPane {...mainPane} />
        </Suspense>
        <div className="app-toast-anchor"><AppToastView {...toast} /></div>
      </div>

      <CloudSetupDialog {...cloudSetup} />
      <ProjectConfirmDialog {...projectConfirm} />
      <AppLazyPanels {...lazyPanels} />
    </div>
    </PageChromeProvider>
  );
}

export type AppSettingsControllerProps = {
  settings: ComponentProps<typeof AppSettingsRoute>;
  toast: ComponentProps<typeof AppToastView>;
};

export function AppSettingsController({ settings, toast }: AppSettingsControllerProps) {
  return (
    <div className="app-settings-shell">
      <AppSettingsRoute {...settings} />
      <div className="app-toast-anchor"><AppToastView {...toast} /></div>
    </div>
  );
}
