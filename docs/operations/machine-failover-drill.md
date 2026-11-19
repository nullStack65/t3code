# Machine-failover drill

The bar: work started on one T3 machine survives that machine going down. Another machine
takes it over and finishes it. When the first machine comes back, it shows the finished state
instead of re-running its stale copy.

```sh
scripts/closura/machine-failover-drill.sh            # expected-fail mode (default)
scripts/closura/machine-failover-drill.sh --strict   # pass only if the whole bar holds
```

Run it from the repository root after `vp i`. It needs Node 24 or newer; set `T3_DRILL_NODE`
if that Node is not on `PATH`. It uses a free mock ACP agent, so it consumes no model usage
and takes about 3–4 minutes.

The drill starts two servers, A and B, on loopback ports. Each has its own temporary home and
its own clone of a bare origin, and the two are linked both ways. A starts N units: one
finishes and the rest hang as long turns. Each in-flight unit pushes a checkpoint branch.
Then the drill SIGKILLs A's whole process group. It never touches `~/.t3` or a live lane.

| Check        | Asserts                                                    |
| ------------ | ---------------------------------------------------------- |
| C1.record    | B holds every unit while A is down                         |
| C2.lease     | B claims A's in-flight units within `--takeover-deadline`  |
| C3.takeover  | B finishes every unit, resuming from the pushed checkpoint |
| C4.fence     | A, back online, runs none of the units B owns              |
| C4.reconcile | A shows every unit completed, matching B                   |

[`machine-failover-drill.gaps`](../../scripts/closura/machine-failover-drill.gaps) lists the
checks that fail today and the gap behind each. Exit codes: 0 means pass, or the failures
match the gaps file; 1 means an unexpected failure; 2 means a usage error; 3 means a listed
gap now passes, so delete its line. Evidence goes to the run directory's `evidence/`, which
defaults to `~/.cache/t3-machine-failover-drill/<time>`. `--keep` also keeps the homes.

Limitation: the units are top-level threads, not a parent with delegated children. The mock
agent cannot issue MCP tool calls yet.
