# Phase 1 evaluation

## Acceptance claim

The engine preserves isolated semantic branches and can selectively merge one field into the active decision state, then undo the operation to the exact previous graph.

## Method

The deterministic test constructs Version A with a ₹40,000 budget, forks Version B, changes B to ₹60,000, switches to A, compares A and B, merges only `accommodation` from B into A, and undoes the merge. It compares complete exported snapshots before and after undo using strict deep equality.

Run:

```bash
npm run test:acceptance
```

## Measured result

As of the latest local run, 13 of 13 tests passed, including the complete Phase 1 acceptance scenario and the formatted-budget comfort-priority regression. These are correctness assertions; the project makes no production latency or accuracy claim.

| Measure | Result | Source |
| --- | ---: | --- |
| Branch contamination assertions | 0 failures | automated test |
| Selective merge assertions | 0 failures | automated test |
| Exact state restoration assertions | 0 failures | strict deep equality |
| Resolver fixture assertions | 0 failures | deterministic phrases |
| Ambiguous reference mutations | 0 | graph snapshot equality |

## Limitations

The phrase resolver covers the Phase 1 demo vocabulary rather than open-ended language. State is currently memory-backed. Voice-path latency, interruption behavior, and speech accuracy cannot be evaluated until Phase 2 adds those systems.
