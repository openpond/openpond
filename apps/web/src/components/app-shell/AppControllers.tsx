import {
  lazy,
  Suspense,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { Sidebar } from "../sidebar/Sidebar";
import { CloudSetupDialog } from "../workspace/CloudSetupDialog";
import { AppLazyPanels, AppSettingsRoute } from "./AppLazyPanels";
import { AppToast as AppToastView } from "./AppToast";
import { AppTopBar } from "./AppTopBar";
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
    <div className={className} style={style}>
      <RenderCommitBoundary id="sidebar">
        <Sidebar {...sidebar} />
      </RenderCommitBoundary>

      <div className="content-shell">
        <AppTopBar {...topBar} />
        <Suspense
          fallback={
            <main className="main-pane" aria-busy="true" aria-label="Loading workspace" />
          }
        >
          <MainPane {...mainPane} />
        </Suspense>
      </div>

      <CloudSetupDialog {...cloudSetup} />
      <ProjectConfirmDialog {...projectConfirm} />
      <AppLazyPanels {...lazyPanels} />
      <AppToastView {...toast} />
    </div>
  );
}

export type AppSettingsControllerProps = {
  settings: ComponentProps<typeof AppSettingsRoute>;
  toast: ComponentProps<typeof AppToastView>;
};

export function AppSettingsController({ settings, toast }: AppSettingsControllerProps) {
  return (
    <>
      <AppSettingsRoute {...settings} />
      <AppToastView {...toast} />
    </>
  );
}
