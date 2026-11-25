import {
  Founder,
  founderInboxLane,
  jointSignOff,
  type FounderSignOff,
  type ThreadInbox,
} from "./threadInbox.ts";

/**
 * What a standing bot shows the founder looking at it. A subtle dot is FYI
 * chatter; the bright badge is reserved for a decision being asked or a founder
 * being named. A joint sign-off shows both founders' answers instead of either.
 */
export type BotAttention =
  | { readonly kind: "quiet" }
  | { readonly kind: "fyi" }
  | { readonly kind: "badge"; readonly label: string }
  | { readonly kind: "sign-off"; readonly founders: ReadonlyArray<FounderSignOff> };

/** Both founders, in the order the pill writes them. */
const JOINT_SIGN_OFF_FOUNDERS: readonly Founder[] = Founder.literals;

/** How much of a message is scanned for an @-mention. The shell stores the names, not the text. */
export const ATTENTION_MENTION_TEXT_LIMIT = 2000;

// The lookbehind keeps an address such as `ops@jeff.example` from being read as a ping.
const FOUNDER_MENTION = /(?<![\w.+-])@(kameron|jeff)\b/gi;

/**
 * What is not prose, per CommonMark: a fenced block, a `>` quoted line, or an inline code span.
 * - A fence is 3+ backticks or tildes. A backtick fence's info string holds no backtick, so
 *   ```` ```@kameron``` ```` on one line is a code span, not a fence. The closing fence repeats the
 *   opener's character at least as many times and has only trailing whitespace. An unterminated
 *   fence runs to the end.
 * - A code span opens on a run of N backticks and closes on the next run of exactly N, so
 *   ``` ``use `x` @jeff`` ``` is one span and a lone ``` `` ``` closes nothing.
 */
const NON_PING_TEXT =
  /^[ \t]*(`{3,})[^`\n]*$(?:\n[\s\S]*?^[ \t]*\1`*[ \t]*$|[\s\S]*)|^[ \t]*(~{3,})[^\n]*(?:\n[\s\S]*?^[ \t]*\2~*[ \t]*$|[\s\S]*)|^[ \t]*>.*$|(?<!`)(`+)(?!`)[^\n]*?(?<!`)\3(?!`)/gm;

/**
 * A founder is pinged only by prose written at them. Logs, code and quotes that merely contain an
 * `@kameron` are incidental, so they must not light the bright pill.
 */
function pingableText(text: string): string {
  return text.replace(NON_PING_TEXT, " ");
}

/** The founders an @-mention names. `@jefferson` is not Jeff. Code, quoted lines and emails do not count. */
export function mentionedFounders(text: string | null | undefined): ReadonlyArray<Founder> {
  if (!text) return [];
  const found = new Set<Founder>();
  for (const match of pingableText(text).matchAll(FOUNDER_MENTION)) {
    const name = match[1]?.toLowerCase();
    if (name === "kameron" || name === "jeff") found.add(name);
  }
  return JOINT_SIGN_OFF_FOUNDERS.filter((founder) => found.has(founder));
}

/** Founders named in a message, or nothing when the text names nobody. */
export function attentionMentionsFromText(
  text: string | null | undefined,
): ReadonlyArray<Founder> | undefined {
  const found = mentionedFounders(text?.slice(0, ATTENTION_MENTION_TEXT_LIMIT));
  return found.length > 0 ? found : undefined;
}

/**
 * The one thing the bot row shows. A joint sign-off outranks a badge, and a
 * badge outranks the FYI dot: a founder being asked must not look like chatter.
 */
export function resolveBotAttention(input: {
  readonly inbox: ThreadInbox | null | undefined;
  readonly viewingFounder: Founder | undefined;
  /** Used only when `mentioned` is omitted. The shell passes names and no message text. */
  readonly latestText?: string | null | undefined;
  readonly mentioned?: ReadonlyArray<Founder> | undefined;
}): BotAttention {
  const ordered = jointSignOff(input.inbox?.decisionRequest?.signOff);
  if (ordered !== null) {
    return { kind: "sign-off", founders: ordered };
  }
  const ask = input.inbox?.decisionRequest;
  if (ask !== undefined) {
    return { kind: "badge", label: decisionBadgeLabel(ask.kind) };
  }
  // Agent-only work is not on a founder's plate, so a name in its text never badges. Only a real
  // decision request (above) can.
  const mentioned =
    input.inbox?.audience === "agent-only"
      ? []
      : input.mentioned !== undefined
        ? input.mentioned
        : mentionedFounders(input.latestText);
  if (mentioned.length > 0) {
    return { kind: "badge", label: mentionBadgeLabel(mentioned) };
  }
  if (isFyi(input.inbox, input.viewingFounder)) return { kind: "fyi" };
  return { kind: "quiet" };
}

function decisionBadgeLabel(kind: "decision" | "review" | "approval"): string {
  if (kind === "approval") return "Approval";
  if (kind === "review") return "Review";
  return "Decision";
}

function mentionBadgeLabel(founders: ReadonlyArray<Founder>): string {
  return founders.map(founderName).join(" · ");
}

function isFyi(
  inbox: ThreadInbox | null | undefined,
  viewingFounder: Founder | undefined,
): boolean {
  if (!inbox) return false;
  if (viewingFounder !== undefined && founderInboxLane(inbox, viewingFounder) === "FYI") {
    return true;
  }
  return inbox.attentionKind === "FYI";
}

/** The name the pill writes, capitalized. */
export function founderName(founder: Founder): string {
  return founder === "kameron" ? "Kameron" : "Jeff";
}
