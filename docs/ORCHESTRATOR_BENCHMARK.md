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
