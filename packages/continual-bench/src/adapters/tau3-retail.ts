import { contentHash } from "../hash.js";

export type Tau3RetailOwnershipInput = {
  taskId: string;
  userId?: string | null;
  orderId?: string | null;
  customerId?: string | null;
  prompt?: string | null;
};

export type Tau3RetailCanonicalOwnership = {
  taskId: string;
  canonicalCustomerId: string;
  orderIds: string[];
  familyId: string;
  resolution: "customer_id" | "user_id" | "order_id";
};

/**
 * Scenario-only canonicalization for Tau3 Retail. Generic split logic consumes
 * the resulting family id and never needs to understand users, customers, or
 * orders.
 */
export function canonicalizeTau3RetailOwnership(
  input: Tau3RetailOwnershipInput,
  lookup: {
    customerForUser?: (userId: string) => string | null;
    customerForOrder?: (orderId: string) => string | null;
    ordersForCustomer?: (customerId: string) => string[];
  },
): Tau3RetailCanonicalOwnership {
  let canonicalCustomerId = clean(input.customerId);
  let resolution: Tau3RetailCanonicalOwnership["resolution"] = "customer_id";
  if (!canonicalCustomerId && clean(input.userId)) {
    canonicalCustomerId = clean(lookup.customerForUser?.(clean(input.userId)!));
    resolution = "user_id";
  }
  if (!canonicalCustomerId && clean(input.orderId)) {
    canonicalCustomerId = clean(lookup.customerForOrder?.(clean(input.orderId)!));
    resolution = "order_id";
  }
  if (!canonicalCustomerId) throw new Error(`Tau3 task ${input.taskId} cannot be resolved to a canonical customer.`);
  const orderIds = [...new Set([...(lookup.ordersForCustomer?.(canonicalCustomerId) ?? []), ...(clean(input.orderId) ? [clean(input.orderId)!] : [])])].sort();
  return {
    taskId: input.taskId,
    canonicalCustomerId,
    orderIds,
    familyId: `tau3-retail-family-${contentHash({ canonicalCustomerId, orderIds })}`,
    resolution,
  };
}

function clean(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
