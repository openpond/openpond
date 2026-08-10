# Checkout latency incident packet

- Incident window: August 7, 2026, 09:42–10:31 UTC.
- Confirmed: p95 checkout latency rose from 780 ms to 4.8 seconds.
- Confirmed: 3.1% of checkout attempts returned HTTP 504.
- Confirmed: the database connection pool reached its configured ceiling.
- Confirmed recovery: increasing the pool ceiling and recycling two workers restored service.
- Hypothesis: a reporting query introduced in release 2026.08.07 increased lock contention.
- Hypothesis: a regional network event amplified connection churn.
- Unknown: whether abandoned carts were later recovered.
- Incident commander: Priya Shah.
- Follow-up owners: Database—Noah Williams; Reporting—Elena García; Customer impact—Sam Lee.
