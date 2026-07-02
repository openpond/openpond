import type { ComponentProps, CSSProperties } from "react";
import { Sidebar } from "../sidebar/Sidebar";
import { CloudSetupDialog } from "../workspace/CloudSetupDialog";
import { AppLazyPanels, AppSettingsRoute } from "./AppLazyPanels";
import { AppToast as AppToastView } from "./AppToast";
import { AppTopBar } from "./AppTopBar";
import { MainPane } from "./MainPane";
import { ProjectConfirmDialog } from "./ProjectConfirmDialog";

export type AppShellControllerProps = {
  className: string;
  style: CSSProperties;
  sidebar: ComponentProps<typeof Sidebar>;
  topBar: ComponentProps<typeof AppTopBar>;
  mainPane: ComponentProps<typeof MainPane>;
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
      <Sidebar {...sidebar} />

      <div className="content-shell">
        <AppTopBar {...topBar} />
        <MainPane {...mainPane} />
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
