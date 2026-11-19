# Watcher thread

One thread, by default Lead's on the laptop, hears everything that needs attention from every linked environment. The server decides each event from thread state with no agent judgment, queues it durably, and retries until the watcher's machine answers.

| Event                  | Fires when                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model-degraded`       | A run ran another model than selected, hit a provider fallback, or hit a usage limit.                                                                                                                                          |
| `lane-ended`           | A top-level lane's run ended `failed` or `interrupted`, or `completed` with open pull requests and nothing tracked to wake it.                                                                                                 |
| `promise-without-wake` | A lane went idle or settled after saying it will be woken or will continue later, with no background task, pull request watch, delegated task or armed resume. The phrase list is `PROMISE_PHRASES` in `ThreadEventAlerts.ts`. |
| `stuck`                | An active run has had no new activity for `watcherStuckMinutes` (default 20; 0 turns it off), or a thread waits on background work that no longer exists. A parent whose child threads are active is not stuck.                |
| `needs-person`         | An agent-created lane raises a pending question or approval, or its inbox is assigned to a founder or set to `action`.                                                                                                         |

Each event reports once per thread and kind until its state changes: a new run, a different message, or the condition clearing. Delivery judges each event again, as of when it fired, and drops one that is no longer true: the lane restarted or was replaced, settled, registered a wait, merged its pull request or got its answer. While the watcher is mid-turn, alerts wait (up to 10 minutes) instead of queueing behind that turn, so they are judged when it can act on them. Delegated children are skipped; their parent already hears their result. The watcher thread never reports about itself.

## Moving the watcher

The watcher is the `modelAlertWatcher` server setting (`{ environmentId, threadId }`, or `null` for none). Its Closura default is in `packages/contracts/src/settings.ts` (`DEFAULT_MODEL_ALERT_WATCHER`). To move Lead to an always-on machine such as the R720, change that one default and ship a build, or set `modelAlertWatcher` in each machine's settings to override it. `modelAlertWebhookUrl` additionally POSTs every alert as JSON.
