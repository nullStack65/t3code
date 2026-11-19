# Inbox and sync verification

How the founder inbox is checked, and what to do when a check fails. The checks are
[`threadInbox.invariants.test.ts`](../packages/contracts/src/threadInbox.invariants.test.ts)
(properties over generated inboxes, with the rules as a plain-English list at the top) and
[`threadInbox.upgrade.test.ts`](../packages/contracts/src/threadInbox.upgrade.test.ts) (real,
anonymized inbox records from the fixture
[`inboxSnapshot.ts`](../packages/contracts/src/__fixtures__/inboxSnapshot.ts), projected by the
current code and compared with the rule that shipped before).

## When an inbox or sync test fails

- First decide which is wrong: the code or the rule. The tests encode founder rules, for example
  Kameron: "a new lane i dont mind seeing, but dont want to see the 5 threads it creates." PR #81
  hid every lane from before it because its rule was wrong, not because the code had a bug. If the
  rule is wrong, change it only with the founder's word, and record that in the spec list at the top
  of the property test file.
- If the upgrade-safety test shows a founder's or machine's count dropping, treat it as a
  regression unless the PR states the drop is intended and gives the founder's rule.
- Never lower a number or delete a fixture record to make a test pass. To cover another machine,
  append its anonymized records to the fixture under its own `environment` label.

## When to escalate to a TLA+ model

- Escalate if the property tests and the upgrade-safety test pass but sync bugs still happen between
  machines: threads lost, duplicated, stale, missing on one environment, or alerts delivered twice
  or never. Also escalate if the same sync bug comes back after two fixes.
- Model only the concurrent part: cross-environment forwarding, the queue and retry, dedupe, and
  settle and route events racing between peers. That is where model checking finds bugs tests miss.
- Keep the pure inbox projection functions under property tests; they don't need TLA+.

## Not Lean, not Bend

- Lean would prove a model, not the TypeScript that runs. The two drift apart, and a proof can't
  catch a wrong rule.
- Bend is a parallel-execution language, not a verification tool.
- Revisit Lean only if a small, stable pure core is extracted and actually reused as the source of
  truth.
