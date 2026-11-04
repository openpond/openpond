import { z } from "zod";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Money = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/).max(24);
const micros = (value:string) => {
  const [whole,fraction=""] = Money.parse(value).split(".");
  return BigInt(whole!)*1_000_000n+BigInt(fraction.padEnd(6,"0"));
};

/** Accepted customer price only. Supplier accounts, hardware costs and
 * infrastructure identities are not part of this public contract. */
export const ComputeAppliedPriceSchema = z.object({
  schemaVersion:z.literal("openpond.computeAppliedPrice.v1"),
  version:z.string().min(1).max(500),
  service:z.enum(["managed_rl","model_modification","model_serving","sandbox"]),
  profileHash:Hash,currency:z.literal("USD"),unit:z.literal("resource_hour"),
  hourlyUsd:Money.refine(value=>{
    if(!Money.safeParse(value).success) return false;
    const amount=micros(value);
    return amount>0n && amount<=BigInt(Number.MAX_SAFE_INTEGER);
  }),
}).strict();
export type ComputeAppliedPrice = z.infer<typeof ComputeAppliedPriceSchema>;

export const ManagedModificationPriceSchema = z.object({
  schemaVersion:z.literal("openpond.modificationPrice.v1"),
  appliedPrice:ComputeAppliedPriceSchema.extend({service:z.literal("model_modification")}),
  billingBoundary:z.literal("active_allocation_until_verified_cleanup"),
  startupBillable:z.literal(true),
  postCompletionIdleBillable:z.literal(false),
  minimumBillableSeconds:z.literal(0),
  warmReuseSeconds:z.literal(300),
}).strict();
export type ManagedModificationPrice = z.infer<typeof ManagedModificationPriceSchema>;

/** Null means use available credits, with native finite execution bounds.
 * Empty form fields have the same meaning; wire-level schemas reject blanks. */
export function canonicalComputeSpendCap(value:string|null|undefined):string|null {
  if(value==null || value.trim()==="") return null;
  const amount=micros(value);
  if(amount<=0n || amount>1_000_000_000_000n)
    throw new OpenPondProtocolError("managed_modification_cap_invalid","Choose a positive spending limit of at most 1,000,000 USD, or use available credits.");
  return `${amount/1_000_000n}.${(amount%1_000_000n).toString().padStart(6,"0")}`;
}

export function assertManagedModificationPricing(plan:{maximumSpendUsd:string|null;runtimeHash:string;computePrice?:ManagedModificationPrice}) {
  if(plan.maximumSpendUsd!==canonicalComputeSpendCap(plan.maximumSpendUsd) ||
    plan.maximumSpendUsd===null && !plan.computePrice ||
    plan.computePrice && plan.computePrice.appliedPrice.profileHash!==plan.runtimeHash)
    throw new OpenPondProtocolError("managed_modification_price_mismatch","Retain the exact reviewed rate, runtime and optional spending limit.");
}

export async function managedModificationPriceApprovalMatches(plan:{computePrice?:ManagedModificationPrice},
  command:{approvedPriceHash?:string}) {
  return plan.computePrice ? command.approvedPriceHash===await canonicalSha256(plan.computePrice)
    : command.approvedPriceHash===undefined;
}
