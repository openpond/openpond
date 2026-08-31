import type { LabWorkproductKind } from "./lab-workproducts";

export type LabDetailKind =
  | LabWorkproductKind
  | "dataset"
  | "scoring"
  | "evaluation"
  | "review";

export type LabDetailLocation = {
  kind: LabDetailKind;
  kindLabel: string;
  kindOnSelect?: () => void;
  workproductLabel: string | null;
  workproductOnSelect?: () => void;
  segments: Array<{
    label: string;
    onSelect?: () => void;
  }>;
};
