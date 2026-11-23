/**
 * The Bots shelf as an org tree. The chain of command mirrors closura-agent-config
 * `config/standing-threads.json` (`reportsTo`): CoS and CEO at the root, the executive team under
 * CEO, and the engineering team under CTO. Founders are humans, never bots, so they have no
 * place here and never list in the Bots shelf.
 */

/** Normalized bot name -> the normalized name it reports to; `null` is a root. */
const REPORTS_TO: Readonly<Record<string, string | null>> = {
  cos: null,
  ceo: null,
  cto: "ceo",
  cfo: "ceo",
  product: "ceo",
  growth: "ceo",
  platform: "cto",
  "infra / arc ops": "cto",
  "release engineer": "cto",
  "pr reviewer": "cto",
};

/** Existing persona names that are the same seat under a longer title. */
const ALIASES: Readonly<Record<string, string>> = {
  "product / site": "product",
  "platform / cto": "platform",
  "infra/arc ops": "infra / arc ops",
  "arc ops": "infra / arc ops",
};

/** Root order and sibling order follow the chart, not the alphabet. */
const SEAT_ORDER = Object.keys(REPORTS_TO);

/** Founders are humans: Kameron and Jeff are never listed as bots. */
const FOUNDER_NAMES = new Set(["kameron", "kameron smith", "jeff", "jeffrey", "jeffrey smith"]);

export function botSeat(name: string | null | undefined): string {
  const key = (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return ALIASES[key] ?? key;
}

export function isFounderName(name: string | null | undefined): boolean {
  return FOUNDER_NAMES.has((name ?? "").trim().toLowerCase().replace(/\s+/g, " "));
}

export interface BotTreeRow<T> {
  readonly thread: T;
  readonly depth: number;
}

type Named = { readonly standing: { readonly name: string } | null; readonly id: string };

function rank(seat: string): number {
  const index = SEAT_ORDER.indexOf(seat);
  return index === -1 ? SEAT_ORDER.length : index;
}

/**
 * Orders bots depth-first by reporting line. A bot whose manager is not in this list (another
 * group, or not yet launched) is shown as a root, so no bot ever disappears. Bots outside the
 * chart come after it, alphabetically.
 */
export function orderBotTree<T extends Named>(threads: readonly T[]): BotTreeRow<T>[] {
  const bySeat = new Map<string, T>();
  for (const thread of threads) {
    const seat = botSeat(thread.standing?.name);
    if (!bySeat.has(seat)) bySeat.set(seat, thread);
  }
  const compare = (left: T, right: T) =>
    rank(botSeat(left.standing?.name)) - rank(botSeat(right.standing?.name)) ||
    (left.standing?.name ?? "").localeCompare(right.standing?.name ?? "", undefined, {
      sensitivity: "base",
    }) ||
    left.id.localeCompare(right.id);
  const parentOf = (thread: T): T | null => {
    const parentSeat = REPORTS_TO[botSeat(thread.standing?.name)];
    const parent = parentSeat ? bySeat.get(parentSeat) : undefined;
    return parent && parent !== thread ? parent : null;
  };
  const children = new Map<T, T[]>();
  const roots: T[] = [];
  for (const thread of threads) {
    const parent = parentOf(thread);
    if (parent === null) roots.push(thread);
    else children.set(parent, [...(children.get(parent) ?? []), thread]);
  }
  const rows: BotTreeRow<T>[] = [];
  const visit = (thread: T, depth: number) => {
    rows.push({ thread, depth });
    for (const child of (children.get(thread) ?? []).toSorted(compare)) visit(child, depth + 1);
  };
  for (const root of roots.toSorted(compare)) visit(root, 0);
  return rows;
}
