const LICENSES_REQUIRING_EXPLICIT_REVIEW = new Set(["unknown", "other"]);

export function approvedLicenseStatus(license: string | null, explicitlyApproved: boolean): "approved" | "review" {
  if (explicitlyApproved) return "approved";
  return !license || LICENSES_REQUIRING_EXPLICIT_REVIEW.has(license.toLowerCase()) ? "review" : "approved";
}
