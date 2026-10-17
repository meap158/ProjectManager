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

## Dispatch insertion/write baseline (2026-10-16)

Reproduce: `node --import tsx scripts/benchmark-orchestrator-dispatch.mjs --samples=20`.
Node 22.21.0; isolated file-backed SQLite, 100,000 accepted historical runs, one
warmup and twenty measured sequential batches. Each batch dispatches one task per
synthetic master through production `dispatchCard` validation, insertion, card
transition and response mapping. Only the OS spawn method is replaced. Assertions
check queued state, zero attempts, one launch-boundary call and one moved card per
dispatch, and stable SQL preparation/mutation counts. A transaction rollback restores
the fixture after each batch; commit/fsync time is excluded.

|  Cards | Masters | Batch p50 ms | Sample p95 ms | Max ms | Row mutations | SQL preparations | Process RSS MB |
| -----: | ------: | -----------: | ------------: | -----: | ------------: | ---------------: | -------------: |
|  1,000 |       1 |        10.33 |         14.13 |  14.52 |             2 |               13 |          102.4 |
|  1,000 |       5 |        58.31 |         89.25 |  90.24 |            10 |               65 |          112.3 |
|  1,000 |      20 |       282.49 |        436.72 | 489.07 |            40 |              260 |          107.8 |
| 10,000 |       1 |         9.03 |         14.37 |  15.48 |             2 |               13 |          104.9 |
| 10,000 |       5 |        56.61 |         72.33 | 118.23 |            10 |               65 |          115.8 |
| 10,000 |      20 |       208.52 |        266.73 | 273.15 |            40 |              260 |          107.5 |

The two mutations are run insertion and card movement. `total_changes()` counts
SQLite row mutations, not disk IO, index-page writes or bytes. Prepared statements
are not rows visited. Sample p95 is nearest-rank over twenty local observations,
not a production latency guarantee; RSS is whole-process state including fixtures.
Variation between cases is not a controlled optimization comparison. This harness
uses synthetic master labels rather than running OrchestratorService ticks. It
excludes scheduler plans/leases/assignments, fresh quota IO, provider discovery,
actual hosted launch, committed WAL durability, network and rendering. Complete
dispatching-tick measurements at 1/5/20 masters remain an explicit separate gate.

## Complete dispatching service-tick baseline (2026-10-16)

Reproduce: `node --import tsx scripts/benchmark-orchestrator-ticks.mjs --samples=20`.
One warmup/twenty samples, file-backed isolated SQLite, 100k accepted historical runs,
20 projects, Todo cards evenly distributed, 1/5/20 enabled project-scoped masters.
Each master allows one worker, with shared provider capacity 32. Actual service ticks
include planning, lease/assignment/event writes, fresh insertion fences, production
quota reads and production dispatch insertion/card transitions. Provider discovery
is warm; unknown quota is allowed for the custom fixture provider. Only the custom
command and OS launch boundary are substituted. Assertions prove exactly one dispatch
and one moved card per master and stable mutation/SQL counts. Every sample starts
fresh event history and rolls back afterward: this measures first transitions, not
settled recurring checks or committed WAL durability. Twenty sequential tick samples
are sample quantiles, not production guarantees. RSS includes the entire fixture.

|  Cards | Masters |   p50 ms | Sample p95 ms |    Max ms | Row mutations | SQL preparations | RSS MB |
| -----: | ------: | -------: | ------------: | --------: | ------------: | ---------------: | -----: |
|  1,000 |       1 |    13.17 |         15.13 |     15.22 |            59 |              202 |  110.3 |
|  1,000 |       5 |   110.66 |        132.90 |    138.49 |           287 |              962 |  127.9 |
|  1,000 |      20 |   806.78 |        888.36 |  1,010.66 |         1,142 |            3,812 |  135.0 |
| 10,000 |       1 |   204.59 |        220.35 |    273.58 |           509 |            1,552 |  141.5 |
| 10,000 |       5 | 2,993.15 |      4,180.52 |  4,869.36 |         2,537 |            7,712 |  145.7 |
| 10,000 |      20 | 8,832.37 |     16,609.05 | 18,086.80 |        10,142 |           30,812 |  144.9 |

The measured run used the same harness before its copied JSON scope label was fixed;
that old printed label incorrectly described insertion-only scope. The executed loop
already called the full service tick. The committed harness label now matches that
loop. No workers or production data were touched. This is a project-scoped first-
transition workload, not global-scope, fresh authenticated provider/quota IO, worker
startup, committed disk durability or mobile/LAN latency.

The scaling exposes a concrete target: event() reloads and rewrites the shared
settings/event blob for every decision, even though only 500 events are retained.
At 10k cards/20 masters the fixture writes 10,142 rows for 20 dispatches. A next change
should batch event persistence while preserving last-transition suppression, event
ordering/counts, bounded retention and updates across asynchronous dispatch checks.
A controlled rerun is required before claiming an improvement.

## Bounded observation batching rerun (2026-10-16)

Same command/fixture and twenty measured samples after batching consecutive non-
dispatch observations. Buffers cap at 500, timestamps are captured when observed,
and events flush before dispatch and at each master's end. Event application retains
sequential order, last-500 retention and exact wait/review/observe duplicate suppression.
Policy and chat edits across asynchronous dispatch are preserved by fresh state reads.

|  Cards | Masters |   p50 ms | Sample p95 ms |   Max ms | Row mutations | SQL preparations | RSS MB |
| -----: | ------: | -------: | ------------: | -------: | ------------: | ---------------: | -----: |
|  1,000 |       1 |    10.62 |         13.98 |    14.96 |            11 |              106 |  110.7 |
|  1,000 |       5 |    72.48 |         84.64 |    89.31 |            47 |              482 |  111.9 |
|  1,000 |      20 |   435.55 |        489.28 |   492.09 |           182 |            1,892 |  130.3 |
| 10,000 |       1 |    23.25 |         29.10 |    29.22 |            11 |              556 |  134.8 |
| 10,000 |       5 |   601.26 |        639.60 |   642.11 |            47 |            2,732 |  154.3 |
| 10,000 |      20 | 3,143.33 |      3,471.98 | 3,533.30 |           182 |           10,892 |  154.5 |

At 10k cards/20 masters the same fixture went from 10,142 to 182 row mutations
(98.2% fewer), with observed median 8,832.37 to 3,143.33 ms. Samples were sequential
local runs, not randomized production A/B trials; timing differences include host
load. Mutation reduction and history equivalence are independently asserted. All
98 Orchestrator tests pass, server types/scoped lint pass. These checks do not
establish a fresh whole-repository pass, committed fsync cost, steady-state/global
scope behavior, provider execution or mobile/LAN latency. Per-decision policy reads
still scale with board size and remain a separate optimization opportunity.

## Fresh-read policy hydration cache (2026-10-16)

The next twenty-sample rerun uses the identical project-scoped first-transition
fixture. Every per-decision and pre-insertion policy check still reads the persisted
settings value. A private prepared SELECT and parse cache reuse hydration only when
the exact raw JSON bytes match. Public mutable state snapshots are unchanged. A
second-connection test changes enabled state and project scope between commit checks
and verifies immediate rejection/restoration; existing task/quota/capacity fences pass.

|  Cards | Masters | p50 ms | Sample p95 ms | Max ms | Row mutations | SQL preparations | RSS MB |
| -----: | ------: | -----: | ------------: | -----: | ------------: | ---------------: | -----: |
|  1,000 |       1 |  10.83 |         13.70 |  14.57 |            11 |               56 |  110.8 |
|  1,000 |       5 |  54.28 |         64.76 |  70.87 |            47 |              228 |  112.2 |
|  1,000 |      20 | 275.76 |        405.85 | 425.63 |           182 |              873 |  131.6 |
| 10,000 |       1 |  16.67 |         19.27 |  23.97 |            11 |               56 |  135.1 |
| 10,000 |       5 | 153.93 |        159.84 | 166.77 |            47 |              228 |  148.3 |
| 10,000 |      20 | 738.48 |        796.31 | 883.13 |           182 |              873 |  158.6 |

The largest fixture's observed median changed from 3,143.33 to 738.48 ms after event
batching, with the same 182 row mutations. The 873 preparations are not 873 queries:
policy SELECT executions still occur for each fresh check, but reuse their prepared
statement. This removes repeated parsing/hydration, not freshness or SQL reads. Timing
runs were sequential and may differ in host load; no production/LAN or committed-fsync
claim follows. All 99 Orchestrator tests, server types, scoped lint and formatting pass.
Global scopes, settled repeated ticks, current provider/quota IO and physical clients
remain separate measurement gates.

## Global and settled tick modes (2026-10-17)

`benchmark-orchestrator-ticks.mjs` now accepts `--scope=project|global` and
`--phase=dispatch|settled`; defaults retain the original project/dispatch case.
For example: `node --import tsx scripts/benchmark-orchestrator-ticks.mjs --samples=5 --scope=global --phase=settled`.
Global masters all cover the portfolio, so their shared one-worker scoped cap
permits one worker total, not one per master. Settled samples first run dispatch
and a second tick to establish waiting observations outside the measured interval.
The measured third tick must launch zero workers and preserve the expected active
card count. Samples remain rollback-isolated; OS execution is replaced, provider
and quota discovery remain production code, and committed fsync/network/browser
costs remain excluded. Five-sample exploratory tails must not be represented as
production percentiles or compared as equivalent to twenty-sample baselines.

Five-sample global/settled exploratory result (2026-10-17), all six fixture
launch-count/card-count assertions passed, process exit 0:

| Cards | Masters | Median ms | Sample maximum ms | Row mutations | SQL preparations |
| ----: | ------: | --------: | ----------------: | ------------: | ---------------: |
|  1000 |       1 |     44.43 |             59.34 |             4 |               39 |
|  1000 |       5 |    273.60 |            281.77 |            12 |              147 |
|  1000 |      20 |   1205.37 |           1326.24 |            42 |              552 |
| 10000 |       1 |    379.88 |            626.18 |            22 |               75 |
| 10000 |       5 |   1954.60 |           2830.82 |           102 |              327 |
| 10000 |      20 |   9953.78 |          13373.23 |           402 |             1272 |

Whole-process RSS ranged 138.5?206.3 MB. With five samples, the computed sample
p95 is simply the maximum; no stable tail claim follows. These are unchanged
third ticks with zero additional launches. The 402 mutations in the largest
fixture reveal remaining event retention/dedup write amplification: 500 retained
events cannot remember every task observation across a 200,000-decision portfolio
sweep. This remains an optimization target, not a completed settled-efficiency gate.

## Observation state separate from display history (2026-10-17)

A first implementation persisted last action/message per master/subject separately
from the 500 display events. In the identical five-sample global/settled fixture,
all measured ticks made only two lease mutations. Median/max ms were respectively:
1k/1: 34.90/39.10; 1k/5: 172.67/180.19; 1k/20: 744.96/938.00;
10k/1: 535.99/1297.04; 10k/5: 2389.19/4563.39; 10k/20: 10469.07/19749.59.
Thus writes fell 402 to 2 in the largest case, but timing did not improve there.
A short service regression also ran during this exploratory measurement; these
numbers are not controlled latency comparisons. The final implementation additionally
caches observation parsing only while freshly read persisted JSON bytes match,
with copy-on-write and rollback coverage. That cache version has not yet had this
benchmark rerun; no timing improvement is claimed for it. Initial transition writes,
map size/cleanup and committed fsync remain separate measurement/scaling work.

## Final parse-cache largest-case rerun (2026-10-17)

The benchmark accepts optional `--cards=1000|10000` and `--masters=1|5|20` selectors;
no selectors still runs the complete matrix. Reproduction:
`node --import tsx scripts/benchmark-orchestrator-ticks.mjs --samples=5 --scope=global --phase=settled --cards=10000 --masters=20`.
The final fresh-byte observation cache completed with exit 0 and all worker/card
assertions passing: median 7559.66 ms, sample maximum 8057.82 ms, two row mutations,
472 SQL preparations and whole-process RSS 320.8 MB. No concurrent test run was
started during this measurement. This is five-sample exploratory evidence, not a
stable p95 or controlled production comparison. It is lower than the original
9953.78 ms median but remains slow; memory grew relative to prior runs. All-master
cache retention, initial snapshot cost and repeated fresh policy reads remain
optimization targets. The result does not establish acceptable portfolio latency.

## Bounded policy refresh in settled global sweeps (2026-10-17)

Settled no-dispatch decisions previously reread persisted master policy for every
card, although those decisions cannot start work. The service now checks policy at
most once per 500 non-dispatch decisions and still reads it immediately for every
dispatch proposal; the existing pre-insertion commit fence remains authoritative.
This bounds pause/scope observation lag to one 500-decision batch without weakening
the launch fence.

Reproduced the exact five-sample command above after this change. All worker/card
assertions passed: median 1610.53 ms, sample maximum 1647.30 ms, two row mutations,
472 prepared statements and 211.0 MB whole-process RSS. The preceding run measured
7290.25 ms median, 7352.89 ms maximum and 211.3 MB RSS. The medians differ by 77.9%
in this sequential synthetic fixture; this is not a randomized production A/B or
LAN latency guarantee. The fixture has 10,000 cards, 100,000 historical runs and
20 global masters, and excludes committed WAL fsync, real worker execution, network
and browser cost. The 1.61s settled global tick remains a material latency target.

## Shared snapshots and amortized observation persistence (2026-10-17)

Masters with an identical project scope now share one read-only scheduling snapshot
per leased tick. Attention follow-up, claims and dispatch completion invalidate it;
the pre-insertion authorization deliberately reads a fresh snapshot. Policy is still
rechecked every 500 waiting decisions. Observation event queues flush at most 5,000
events at once, and display-history retention now slices once per batch rather than
shifting per transition. This keeps queued memory bounded while reducing repeated
serialization and writes for large portfolios.

Settled reproduction:
`node --import tsx scripts/benchmark-orchestrator-ticks.mjs --samples=5 --scope=global --phase=settled --cards=10000 --masters=20`.
Latest current-worktree result: 1859.99ms median, 2419.27ms sample maximum, two row
mutations, 15 prepared statements and 217.3MB process RSS. The immediate pre-cache
run used 72 statements and measured 2908.30ms median; an earlier query-projection run
measured 1529.99ms, demonstrating that host timing varies. No percentage latency
claim is made.

Dispatch reproduction:
`node --import tsx scripts/benchmark-orchestrator-ticks.mjs --samples=5 --scope=global --phase=dispatch --cards=10000 --masters=20`.
It dispatches one worker under the shared global cap, with 10,000 cards, 100,000
historical runs and 20 masters. The five-sample result was 1737.78ms median,
2465.84ms sample maximum, 92 row mutations, 176 prepared statements and 208.1MB
process RSS. A prior two-sample run before the larger write batch had 812 mutations,
1256 preparations and 6500.73ms median. The mutation and preparation counts directly
show fewer DB rewrites; unequal sample sizes and machine load make the timing
comparison exploratory. Neither phase includes committed WAL fsync, actual provider
execution, LAN or browser latency. These fixtures do not establish production p95,
acceptable maximum portfolio latency, or a total memory bound.
