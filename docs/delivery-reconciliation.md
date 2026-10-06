# Delivery investigation (read only)

A successful Redis XADD followed by sender `published_at` commit is not durable receiver acceptance. Redis loss can leave a published sender without a receiver ledger row. Missing SQL rows also cannot prove that execution or paid work never happened.

Inspect one original identity using the existing administrative database credentials (`DATABASE_URL`, `IO_TIMEOUT_MS`):

```sh
bun scripts/reconcile-deliveries.ts command <original-command-uuid>
bun scripts/reconcile-deliveries.ts event <original-event-uuid>
```

The tool reads sender and receiver rows in one read-only, repeatable-read transaction. Output contains private payloads: keep it in a secure operator environment, not public logs. It does not discover candidates, classify recovery eligibility, update publication timestamps, send Redis entries, or execute work. There is no `--apply` mode or review-file protocol.

## Manual investigation

1. Verify the actual database, roles, SQL durability and continuous history, fault timeline, and original execution environment. Stop if SQL was restored, deleted, rolled back, or its integrity is unknown.
2. Pause affected publishers and receiver intake and drain in-flight acceptance before considering any separately authorized recovery. A live inspection is only evidence, not a lock or authorization to requeue.
3. Compare retained sender payload and indexed identities with receiver ledgers, run state, event ordinal/terminal records, history, and original provider/environment evidence. Receiver absence alone cannot exclude unknown spend.
4. Any recovery requires a separate reviewed operational procedure. Preserve original command/event/run/message IDs, payloads, ordinals, history, and environment identity. Never create replacement work, clear ledgers, reset leases/history, or perform an unlocked online requeue to make replay pass.
5. Unknown transport or COMMIT outcomes require read-only verification of the original identities. Do not automatically retry execution or infer rollback from a lost response.

`query_timeout` bounds client response waiting; it does not cancel remote SQL. Server statement/lock/idle-transaction timeout options are supplied through public pg configuration. URL/startup timeout precedence is operator configuration responsibility. Normal SQL/business failures can roll back without failing the process; unknown query transport failures notify the process owner to stop intake.

Tests exercise exact test-owned XADD entry loss and same-envelope redelivery with durable receiver deduplication. This is not a real Redis power-loss experiment, production recovery authorization, an RPO/RTO guarantee, or exactly-once execution.
