import { useCallback, useMemo, useState } from "react";
import type { LabDetailLocation } from "../components/labs/lab-detail-navigation";
import type { LabDetailKind } from "../components/labs/lab-detail-navigation";

export function useLabDetailNavigation(active: boolean) {
  const [closeDetailRequest, setCloseDetailRequest] = useState<{
    id: number;
    kind: LabDetailKind | null;
  }>({ id: 0, kind: null });
  const [detailLocation, setDetailLocation] = useState<LabDetailLocation | null>(null);
  const requestClose = useCallback((kind: LabDetailKind | null = null) => {
    setCloseDetailRequest((current) => ({ id: current.id + 1, kind }));
  }, []);
  const onDetailOpenChange = useCallback((location: LabDetailLocation | null) => {
    setDetailLocation(location);
  }, []);
  const backAction = null;
  const breadcrumbs = useMemo(() => {
    if (!active) return undefined;
    if (!detailLocation) return [{ label: "Lab" }];
    if (detailLocation.kind === "dataset") {
      return [
        { label: "Lab", onSelect: () => requestClose(null) },
        { label: "Datasets", onSelect: () => requestClose("dataset") },
        ...(detailLocation.workproductLabel
          ? [{ label: detailLocation.workproductLabel }]
          : []),
        ...detailLocation.sectionLabels.map((label) => ({ label })),
      ];
    }
    return [
      { label: "Lab", onSelect: () => requestClose(null) },
      { label: "Home", onSelect: () => requestClose(null) },
      {
        label: detailLocation.kindLabel,
        onSelect: () =>
          requestClose(detailLocation.kind === "model" ? null : detailLocation.kind),
      },
      ...(detailLocation.workproductLabel ? [{ label: detailLocation.workproductLabel }] : []),
      ...detailLocation.sectionLabels.map((label) => ({ label })),
    ];
  }, [active, detailLocation, requestClose]);

  return {
    backAction,
    breadcrumbs,
    closeDetailKind: closeDetailRequest.kind,
    closeDetailRequestId: closeDetailRequest.id,
    onDetailOpenChange,
  };
}
