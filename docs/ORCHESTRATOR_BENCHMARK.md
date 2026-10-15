# Orchestrator planner baseline

Measured 2026-10-11 on Node 22.21.0 using
`node --expose-gc --import tsx scripts/benchmark-orchestrator.mjs`.
Each case uses 100,000 historical runs, 20 projects, three warmups and 12 timed samples.
Times cover sequential pure planner calls for all stated masters, with capacity assertions.
JSON bytes describe one master's decisions; RSS describes the whole process.

| Cards  | Masters | p50 ms | p95 ms | Decision bytes/master | RSS MB |
| ------ | ------- | ------ | ------ | --------------------- | ------ |
| 1,000  | 1       | 8.30   | 22.07  | 184,448               | 116.4  |
| 1,000  | 5       | 35.06  | 39.10  | 184,448               | 117.2  |
| 1,000  | 20      | 135.10 | 147.97 | 184,448               | 117.2  |
| 10,000 | 1       | 22.84  | 28.71  | 1,854,399             | 131.8  |
| 10,000 | 5       | 95.96  | 112.27 | 1,854,399             | 188.0  |
| 10,000 | 20      | 393.85 | 409.97 | 1,854,399             | 193.8  |

The preview endpoint adds retry and execution metadata, so its uncompressed payload is
larger. Prioritize a compact versioned overview and bounded or paginated decisions for
mobile. Share indexed latest-run projections across masters rather than repeatedly
converting all historical runs.

This is an exploratory baseline, not a before/after comparison or LAN latency measurement.
It excludes SQL, quota IO, provider subprocesses and transport, and touches no live tasks.
Still measure complete tick p50/p95, query count, quota reads, writes, actual API bytes,
and mobile transfer/render time. Repeat under controlled memory/load before selecting
release thresholds; twelve samples are insufficient for firm tail-latency guarantees.

## Home situation indexing (2026-10-11)

Compared HEAD's pre-index situation builder with the revised builder using identical synthetic
inputs and JSON equality of the complete output. Fixture: 1,000 review cards, 100,000 runs
spread across those cards, 20 running runs and the rest accepted/succeeded, no sessions or
project alerts. One warm-up and five measured calls per implementation on this Windows host.

| Builder               | Median      | Maximum observed |
| --------------------- | ----------- | ---------------- |
| Per-card scans        | 2,769.92 ms | 3,230.85 ms      |
| Indexed workers/flags | 12.51 ms    | 20.07 ms         |

The revised builder indexes live workers by card and attention kinds by card once instead
of rescanning all runs/sessions/attention for every card. Session-first/run-second ordering
and deduplicated flag ordering are preserved. Existing situation identity/scope tests pass.
This is an isolated synthetic builder benchmark, not an end-to-end latency guarantee; it
excludes SQL, provider/quota reads, session screen collection and network transfer. Temporary
baseline module was removed after measurement; no live tasks or terminals were changed.

## Database projections and candidate indexes (2026-10-12)

Reproduce with `node --import tsx scripts/benchmark-orchestrator-db.mjs`.
In-memory SQLite fixture: 100,000 runs, 1,000 review cards, 20 projects, master scope
project 1; 20 old live runs and remaining runs accepted. Two warm-ups, ten samples.
Candidate partial indexes are created only in the fixture; complete query outputs are
asserted identical before/after. No live workers or application database are changed.

| Operation                                        | Current median ms | Candidate indexed median ms | Result rows |
| ------------------------------------------------ | ----------------: | --------------------------: | ----------: |
| Full history rows + command/change JSON decoding |          1,329.64 |                Not measured |     100,000 |
| Planning projection                              |              9.49 |                        0.53 |          71 |
| Situation identity projection                    |              5.25 |                        0.10 |          51 |
| Distinct live project occupancy                  |             41.43 |                        0.02 |          20 |

Candidate indexes: `(project_id,id)` restricted to live statuses; same columns restricted
to succeeded/failed unvalidated runs; same columns restricted to card-linked runs.
EXPLAIN confirms live-index scan and project-index searches for review and last-served
queries. These indexes are not yet production migrations. Coordinate the append-only
migration with concurrent database changes and verify upgrade/index plans before adoption.
The baseline decoder is a benchmark approximation of supervisor conversion, not an exact
end-to-end old API comparison. Timing excludes provider/quota IO, network, rendering and
writes; small samples and host load limit tail-latency conclusions. Index write/storage
costs, unscoped masters and large pending-review populations still need measurement.

## Complete read-route measurements (2026-10-13)

Reproduce: `node --import tsx scripts/benchmark-orchestrator-api.mjs --cards=1000,10000 --masters=1 --samples=5`.
In-memory SQLite, 20 projects, 100,000 runs, review cards with one latest unreviewed run each,
and 20 live runs. Real Hono routes include SQL, service construction and JSON serialization.
One warmup and five samples on Node 22.21.0. Baseline uses per-run supervisor hydration;
revision scopes cards in SQL and projects only the situation's run fields in one query.

| Scope        |  Cards | Baseline median ms | Projected median ms | Response bytes |
| ------------ | -----: | -----------------: | ------------------: | -------------: |
| Project 1    |  1,000 |              30.46 |                4.21 |         26,881 |
| All projects |  1,000 |             609.18 |              103.58 |        538,385 |
| Project 1    | 10,000 |             317.87 |               27.52 |        269,431 |
| All projects | 10,000 |           1,693.83 |              386.25 |      5,409,189 |

Response bytes match before/after. The harness also asserts complete visible equality against
old hydration, excluding generation timestamps, and no database writes during measurements.
Warm provider/quota caches, no worker launches, no live database writes. These exploratory
in-process measurements exclude network/browser/cold-provider latency; five samples and
concurrent host load do not establish tail-latency guarantees. The 5.4 MB response remains
an explicit summary/pagination gap. Multi-master and dispatch/write-cost measurements remain.

## Multi-master read routes (2026-10-14)

Reproduce: `node --import tsx scripts/benchmark-orchestrator-api.mjs --cards=1000,10000 --masters=1,5,20 --samples=5`.
Raw results: [measurement artifact](orchestrator-api-benchmark-2026-10-14.json).
Each sample issues requests sequentially for all masters; times below are batch totals,
not per-master latency. One warmup and five samples, warm caches, isolated in-memory database.
Read-only and pending/full-situation equivalence assertions passed.

| 10k cards, global scope | Masters | Median batch ms | Maximum batch ms | Bytes per master |
| ----------------------- | ------: | --------------: | ---------------: | ---------------: |
| Preview                 |       1 |          122.76 |           161.79 |           41,397 |
| Preview                 |      20 |        1,793.11 |         1,961.87 |           41,397 |
| Full situation          |       1 |          377.00 |           480.85 |        5,409,189 |
| Full situation          |      20 |        4,012.85 |         6,925.87 |        5,409,189 |
| Pending page            |       1 |          203.73 |           213.46 |            4,562 |
| Pending page            |      20 |        2,418.39 |         2,576.99 |            4,562 |

For 20 project-scoped masters, median totals were 198.33 ms preview, 185.15 ms situation,
and 212.82 ms pending. Separate runs and concurrent host load prevent treating these values
as controlled speedups. Five samples do not establish p95; RSS is a process snapshot, not
operation-specific peak memory. No network, mobile browser, dispatch ticks or index write
cost is included. Global pending computation still repeats unresolved-work reads per master.

## Workspace run feed and SQL preparation counts (2026-10-14)

Reproduce: `node --import tsx scripts/benchmark-orchestrator-api.mjs --cards=1000,10000 --masters=1 --samples=5 --operations=runs`.
The harness now supports operation selection and records prepared SQL statement counts per
batch (not rows visited, quota IO or filesystem log-stat counts). Counts are stable across
samples and timed routes assert no database writes. This fixture has 100k runs, many
unreviewed runs, and no owned history; it measures actionable-feed growth, not history paging.

|  Cards | Scope   | Median ms | Maximum ms | Response bytes | SQL preparations |
| -----: | ------- | --------: | ---------: | -------------: | ---------------: |
|  1,000 | Project |      2.24 |       4.04 |         21,403 |                4 |
|  1,000 | Global  |     41.13 |      50.12 |        426,698 |                4 |
| 10,000 | Project |     14.83 |      17.02 |        210,403 |                4 |
| 10,000 | Global  |    324.46 |     361.61 |      4,211,650 |                4 |

Node 22.21.0, one warmup/five samples, isolated in-process Hono/SQLite/serialization. No
network/mobile latency claim; five samples do not establish p95. Batching bounds SQL
preparations but not unresolved rows, hydration/log stats, JSON or response bytes. The global
4.21 MB run feed remains a measured summary/actionable-pagination gap. Keep all pending
reviews discoverable through counts and pages; a fixed newest-run cutoff would regress it.

## Bounded actionable-run details (2026-10-14)

`--cards=10000 --masters=1 --samples=5 --operations=actionable-runs` measured a 20-row
SQL page with complete scalar counts. Project scope: 2.04 ms median, 2.50 ms maximum,
8,591 response bytes; global scope: 24.93 ms median, 27.33 ms maximum, 8,611 bytes.
Both used four prepared SQL statements. This is the same isolated read-only fixture scope,
not controlled LAN/mobile latency or p95. Earlier unbounded global feed was 4,211,650 bytes.
The page endpoint bounds hydration/transport but still aggregates unresolved rows for counts.
Client integration is still required before the polling page benefits from this reduction.

## SQL pending pages across masters (2026-10-15)

Command: `node --import tsx scripts/benchmark-orchestrator-api.mjs --cards=1000,10000 --masters=1,5,20 --samples=5 --operations=pending`.
Node 22.21.0; 100,000 historical runs. Five warm measured samples per case, local Hono request
handling/SQL/serialization. Each row times the complete sequential master batch. The harness
checks pending totals and page equality against the full situation baseline and rejects
unexpected database writes. No workers, live database, network or browser are involved.

| Cards  | Scope   | Masters | Batch median ms | Batch max ms | Prepared statements/batch | Bytes/master | Process RSS MB |
| ------ | ------- | ------- | --------------- | ------------ | ------------------------- | ------------ | -------------- |
| 1,000  | Project | 1       | 2.26            | 2.71         | 5                         | 4,493        | 126.9          |
| 1,000  | Project | 5       | 6.31            | 6.86         | 25                        | 4,493        | 131.8          |
| 1,000  | Project | 20      | 25.09           | 28.54        | 100                       | 4,515        | 144.0          |
| 1,000  | Global  | 1       | 1.26            | 1.32         | 5                         | 4,521        | 154.8          |
| 1,000  | Global  | 5       | 7.03            | 7.65         | 25                        | 4,521        | 159.8          |
| 1,000  | Global  | 20      | 22.74           | 32.30        | 100                       | 4,521        | 159.7          |
| 10,000 | Project | 1       | 1.22            | 1.42         | 5                         | 4,534        | 161.9          |
| 10,000 | Project | 5       | 6.06            | 6.35         | 25                        | 4,534        | 167.1          |
| 10,000 | Project | 20      | 22.72           | 30.35        | 100                       | 4,556        | 169.1          |
| 10,000 | Global  | 1       | 2.34            | 2.51         | 5                         | 4,562        | 190.1          |
| 10,000 | Global  | 5       | 15.09           | 23.30        | 25                        | 4,562        | 232.7          |
| 10,000 | Global  | 20      | 49.05           | 54.94        | 100                       | 4,562        | 233.5          |

The global case repeats the same large scope for every master; the project case scopes each
master separately. RSS is the whole benchmark process at that point, including fixtures and
prior cases; it is not endpoint allocation or retained-memory evidence. Five samples do not
establish p95. This verifies bounded response detail and observed read scaling, not bounded
COUNT cost, cold caches, concurrent clients, provider calls, dispatch writes, LAN/render time
or complete tick latency. Dispatch/write-cost and physical-client gates remain open.
