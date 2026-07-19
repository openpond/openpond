import type { LabWorkproductKind } from "./lab-workproducts";

export type LabDetailKind = LabWorkproductKind | "dataset";

export type LabDetailLocation = {
  kind: LabDetailKind;
  kindLabel: string;
  workproductLabel: string | null;
  sectionLabels: string[];
};
