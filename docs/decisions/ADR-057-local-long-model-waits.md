# ADR-057 — Long model waits in the local synthetic pipeline

Status: assigned 12 October 2026 following the user's explicit deadline change. Parent RAG-01/JOB-01 remain in progress.

Local real once/resume requests need more than the previous 25/26-second pair. Use 15 minutes per request, configurable down to 1 second through a backend-only local setting, with a processor fallback 1 second later. This selects the user's long-timeout alternative; it does not claim an infinite or upstream-unlimited request. Existing Worker/smoke defaults and L3 budgets do not change.

Use the existing native Node HTTP transport for local long requests, underneath the provider's explicit deadline/cancellation, to avoid an unrelated shorter fetch transport limit. Preserve source/schema/byte/token limits, the maximum three-request attempt and explicit extraction output policy. Timeout policy is part of state ownership, with the old 25-second profile preserved for historical read/resume compatibility.

Renew only the exact current private AI lease during long waits. Keep its five-minute duration and use fenced, nonoverlapping renewals; loss/expiry must deny late writes and further calls. Stop/join timers and transport on cancellation and resource cleanup. Crashes without renewal remain recoverable under existing lease expiry/backoff. A request can repeat after an unrecorded response; this is not exactly-once inference or proof the upstream stopped.

Forward closed provider observations to the root-only synthetic probe so timeout, cancellation, transport, HTTP and invalid-response outcomes can be distinguished without raw errors. Publication and real sources remain disabled. Implementation, independent review and actual long-wait verification are pending in [the assignment](../assignments/RAG-01-LOCAL-LONG-WAIT.md).
