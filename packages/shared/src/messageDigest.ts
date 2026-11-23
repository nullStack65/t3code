import type { OrchestrationV2DigestCategory, OrchestrationV2DigestEntry } from "@t3tools/contracts";

const SECTIONS: ReadonlyArray<readonly [OrchestrationV2DigestCategory, string]> = [
  ["decision_needed", "Decisions needed"],
  ["alert", "Alerts"],
  ["lane_result", "Lane results"],
  ["fyi", "FYI"],
];

/** Prepends the digest messages a turn carries, grouped by category. */
export function formatDigestForProvider(
  text: string,
  digest: ReadonlyArray<OrchestrationV2DigestEntry> | undefined,
) {
  if (digest === undefined || digest.length === 0) return text;
  const sections = SECTIONS.flatMap(([category, title]) => {
    const entries = digest.filter((entry) => entry.category === category);
    return entries.length === 0
      ? []
      : [`## ${title}\n${entries.map((entry) => `- ${entry.text.trim()}`).join("\n")}`];
  });
  const noun = digest.length === 1 ? "message" : "messages";
  return [
    `<digest count="${digest.length}">`,
    `${digest.length} ${noun} arrived without starting a turn:`,
    ...sections,
    "</digest>",
    "",
    text,
  ].join("\n");
}
