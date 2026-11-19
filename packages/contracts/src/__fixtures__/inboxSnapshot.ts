// Anonymized inbox records from a real T3 database: routing fields only, no titles, messages or
// ids. One entry per distinct shape with its thread count; captured 2026-11-19 on the ASUS host.
// Add a machine under its own `environment` label; never lower a count to pass a test.
export const INBOX_SNAPSHOT = [
  {
    environment: "env-1",
    topLevel: false,
    settled: false,
    archived: false,
    inbox: {
      owner: "kameron",
      assignee: {
        kind: "agent",
        id: "agent",
      },
      audience: "agent-only",
      attentionKind: "background",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 4,
  },
  {
    environment: "env-1",
    topLevel: false,
    settled: false,
    archived: false,
    inbox: {
      owner: null,
      assignee: {
        kind: "agent",
        id: "agent",
      },
      audience: "agent-only",
      attentionKind: "background",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 2,
  },
  {
    environment: "env-1",
    topLevel: false,
    settled: true,
    archived: false,
    inbox: {
      owner: "kameron",
      assignee: {
        kind: "agent",
        id: "agent",
      },
      audience: "agent-only",
      attentionKind: "background",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 65,
  },
  {
    environment: "env-1",
    topLevel: false,
    settled: true,
    archived: false,
    inbox: {
      owner: null,
      assignee: {
        kind: "agent",
        id: "agent",
      },
      audience: "agent-only",
      attentionKind: "background",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 90,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: false,
    archived: false,
    inbox: {
      owner: "kameron",
      assignee: {
        kind: "agent",
        id: "agent",
      },
      audience: "kameron",
      attentionKind: "FYI",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 7,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: false,
    archived: false,
    inbox: {
      owner: "kameron",
      assignee: {
        kind: "agent",
        id: "agent",
      },
      audience: "kameron",
      attentionKind: "FYI",
      reason: "fyi",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 4,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: false,
    archived: false,
    inbox: {
      owner: "kameron",
      assignee: {
        kind: "human",
        id: "kameron",
      },
      audience: "kameron",
      attentionKind: "FYI",
      reason: "fyi",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 3,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: false,
    archived: false,
    inbox: {
      owner: null,
      assignee: {
        kind: "agent",
        id: "agent",
      },
      audience: "agent-only",
      attentionKind: "background",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 1,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: true,
    archived: false,
    inbox: {
      owner: "kameron",
      assignee: {
        kind: "agent",
        id: "agent",
      },
      audience: "agent-only",
      attentionKind: "background",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 10,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: true,
    archived: false,
    inbox: {
      owner: "kameron",
      assignee: {
        kind: "agent",
        id: "agent",
      },
      audience: "kameron",
      attentionKind: "FYI",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 4,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: true,
    archived: false,
    inbox: {
      owner: "kameron",
      assignee: {
        kind: "human",
        id: "kameron",
      },
      audience: "agent-only",
      attentionKind: "background",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 6,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: true,
    archived: false,
    inbox: {
      owner: "kameron",
      assignee: {
        kind: "human",
        id: "kameron",
      },
      audience: "kameron",
      attentionKind: "action",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 9,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: true,
    archived: false,
    inbox: {
      owner: "kameron",
      assignee: {
        kind: "human",
        id: "kameron",
      },
      audience: "shared",
      attentionKind: "background",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 1,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: true,
    archived: false,
    inbox: {
      owner: null,
      assignee: {
        kind: "agent",
        id: "agent",
      },
      audience: "agent-only",
      attentionKind: "background",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 23,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: true,
    archived: false,
    inbox: {
      owner: null,
      assignee: null,
      audience: "agent-only",
      attentionKind: "background",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 5,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: true,
    archived: false,
    inbox: {
      owner: null,
      assignee: null,
      audience: "agent-only",
      attentionKind: "background",
      origin: null,
      requestedBy: null,
      actor: null,
      executorEnvironmentId: null,
    },
    count: 1,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: true,
    archived: false,
    inbox: {
      owner: null,
      assignee: null,
      audience: "agent-only",
      attentionKind: "FYI",
      origin: {
        kind: "agent",
        id: "agent",
      },
      requestedBy: {
        kind: "agent",
        id: "agent",
      },
      actor: {
        kind: "agent",
        id: "agent",
      },
      executorEnvironmentId: "env-1",
    },
    count: 1,
  },
  {
    environment: "env-1",
    topLevel: true,
    settled: true,
    archived: false,
    inbox: null,
    count: 2,
  },
] as const;
