import type { ManagedModificationPrice } from "openpond-sdk/training";

export function modificationSpendLabel(cap: string | null | undefined) {
  return cap == null ? "Use available credits" : `$${cap} USD`;
}

/** Only the prepared plan supplies the rate the user approves. */
export function ManagedModificationPriceDetails({ price }: { price?: ManagedModificationPrice }) {
  if (!price) return null;
  return (
    <>
      <dt>Usage rate</dt>
      <dd>
        $
        {Number(price.appliedPrice.hourlyUsd).toLocaleString(undefined, {
          maximumFractionDigits: 6,
        })}
        /hour
      </dd>
      <dt>Billing</dt>
      <dd>
        Startup, model work and cleanup. Queue time and warm idle after completion are not billed.
      </dd>
    </>
  );
}

export function modificationStartTerms(price?: ManagedModificationPrice) {
  return price
    ? "Start approves this request and usage rate. Credits are checked when compute is allocated. Work stops when credits or your spending limit run out. Saving and reviewing do not start compute."
    : "Start this exact prepared request using workspace credits and capacity. The approved maximum includes the bounded execution; preparation does not reserve a worker.";
}

export function modificationStartLabel(cap: string | null) {
  return cap === null ? "Start using credits" : `Start with $${cap} cap`;
}
