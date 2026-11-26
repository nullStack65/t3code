import {
  AssistantCitation,
  type EnvironmentId,
  type MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { formatAssistantCitationForComposer } from "./composer-logic";
import { createAssistantTextSelector } from "./lib/assistantTextSelection";

const isAssistantCitation = Schema.is(AssistantCitation);

export const REPLY_TO_QUESTION_LABEL = "Reply to this question";

/** Custom answers can hold a quote. Option-only questions cannot. */
export function showReplyToQuestion(question: {
  readonly allowCustomAnswer?: boolean | undefined;
}): boolean {
  return question.allowCustomAnswer !== false;
}

interface QuestionReplyMessage {
  readonly id: MessageId;
  readonly role: string;
  readonly text: string;
}

/**
 * Text to insert at `cursor`.
 *
 * An assistant message that contains the question reuses the citation chip.
 * A founder's own question, or a question that is not a message, is a plain
 * quote. That quote must not be labeled as an assistant quote.
 */
export function questionReplyInsertion(input: {
  readonly question: string;
  readonly answer: string;
  readonly cursor: number;
  readonly messages: ReadonlyArray<QuestionReplyMessage>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string | null {
  const questionText = input.question.trim();
  if (questionText.length === 0) return null;

  const citation = assistantCitationForQuestion(questionText, input);
  const quote = citation
    ? formatAssistantCitationForComposer(citation)
    : formatQuestionQuote(questionText);
  return placeAtCursor(input.answer, input.cursor, quote, citation ? "inline" : "block");
}

function assistantCitationForQuestion(
  questionText: string,
  input: {
    readonly messages: ReadonlyArray<QuestionReplyMessage>;
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  },
): AssistantCitation | null {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (!message) continue;
    const start = message.text.indexOf(questionText);
    if (start === -1) continue;
    // The newest copy wins. A founder's later message is their question, not the assistant's.
    if (message.role !== "assistant") return null;
    const selector = createAssistantTextSelector(message.text, start, start + questionText.length);
    if (!selector) return null;
    const citation = {
      version: 1 as const,
      environmentId: input.environmentId,
      threadId: input.threadId,
      messageId: message.id,
      ...selector,
    };
    return isAssistantCitation(citation) ? citation : null;
  }
  return null;
}

function formatQuestionQuote(question: string): string {
  const body = question
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  // oxlint-disable-next-line t3code/no-untranslated-copy -- the quote is composer text sent to the agent, which stays English
  return `> Question:\n${body}\n\n`;
}

function placeAtCursor(
  answer: string,
  cursorInput: number,
  quote: string,
  kind: "inline" | "block",
): string {
  const cursor = Number.isFinite(cursorInput)
    ? Math.max(0, Math.min(answer.length, Math.floor(cursorInput)))
    : answer.length;
  const before = answer.slice(0, cursor);
  if (before.length === 0) return quote;
  if (kind === "inline") {
    return /\s/.test(before[before.length - 1] ?? "") ? quote : ` ${quote}`;
  }
  if (before.endsWith("\n\n")) return quote;
  if (before.endsWith("\n")) return `\n${quote}`;
  return `\n\n${quote}`;
}
