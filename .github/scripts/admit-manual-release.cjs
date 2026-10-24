async function admitManualRelease({ github, context, env }) {
  const repository = context.payload.repository;
  if (
    context.eventName !== "workflow_dispatch" ||
    repository?.full_name !== "nullStack65/t3code" ||
    String(repository?.owner?.id) !== "112618179" ||
    repository?.default_branch !== "main" ||
    context.ref !== "refs/heads/main" ||
    context.actor !== "nullStack65" ||
    env.GITHUB_ACTOR_ID !== "112618179" ||
    env.GITHUB_TRIGGERING_ACTOR !== "nullStack65" ||
    env.GITHUB_RUN_ATTEMPT !== "1"
  ) {
    throw new Error("Release requires a first-attempt owner dispatch on this repository main.");
  }
  const source = env.REVIEWED_SOURCE_SHA;
  const workflow = env.REVIEWED_WORKFLOW_SHA;
  if (
    !/^[0-9a-f]{40}$/.test(source ?? "") ||
    !/^[0-9a-f]{40}$/.test(workflow ?? "") ||
    workflow !== context.sha ||
    workflow !== env.WORKFLOW_SHA
  ) {
    throw new Error("Supply exact reviewed source and current workflow commit SHAs.");
  }
  if (env.VERSION_OVERRIDE) {
    throw new Error(
      "Commit and review version changes before release; inline version overrides are refused.",
    );
  }
  const { data: main } = await github.rest.repos.getBranch({
    owner: "nullStack65",
    repo: "t3code",
    branch: "main",
  });
  if (main.commit.sha !== workflow) {
    throw new Error("Main changed after review; review its current workflow and dispatch again.");
  }
  return source;
}

function assertReviewedReleaseSource(actual, reviewed) {
  if (actual !== reviewed)
    throw new Error("Resolved release source differs from the reviewed source SHA.");
}

module.exports = { admitManualRelease, assertReviewedReleaseSource };
