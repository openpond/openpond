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
    return buildLabDetailBreadcrumbs(detailLocation, requestClose);
  }, [active, detailLocation, requestClose]);

  return {
    backAction,
    breadcrumbs,
    closeDetailKind: closeDetailRequest.kind,
    closeDetailRequestId: closeDetailRequest.id,
    onDetailOpenChange,
  };
}

export function buildLabDetailBreadcrumbs(
  detailLocation: LabDetailLocation | null,
  requestClose: (kind: LabDetailKind | null) => void,
) {
  if (!detailLocation) return [{ label: "Models" }];
  return [
    {
      label: "Models",
      onSelect: () => requestClose(null),
    },
    {
      label: detailLocation.kindLabel,
      onSelect:
        detailLocation.kindOnSelect ??
        (() => requestClose(detailLocation.kind)),
    },
    ...(detailLocation.workproductLabel
      ? [{
          label: detailLocation.workproductLabel,
          onSelect: detailLocation.workproductOnSelect,
        }]
      : []),
    ...detailLocation.segments,
  ];
}
