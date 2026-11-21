import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  expandAssistantCitationsForProvider,
  parseAssistantCitationHref,
} from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import { projectPendingUserInputAnswer } from "./pendingUserInput";
import {
  questionReplyInsertion,
  REPLY_TO_QUESTION_LABEL,
  showReplyToQuestion,
} from "./questionReply";

const environmentId = EnvironmentId.make("env-question");
const threadId = ThreadId.make("thread-question");
const assistantMessageId = MessageId.make("assistant-question");
const founderMessageId = MessageId.make("founder-question");
const question = "Which database should we use?";
const legacyHref =
  "t3-citation://v1/a/b/c?text=A+quote+%26+a+newline.%0A&start=0&end=21&prefix=&suffix=+Next.";

function insert(
  messages: ReadonlyArray<{ id: MessageId; role: string; text: string }>,
  answer = "",
  cursor = answer.length,
) {
  return questionReplyInsertion({
    question,
    answer,
    cursor,
    messages,
    environmentId,
    threadId,
  });
}

describe("question reply", () => {
  it("hides the control when a custom answer is not allowed", () => {
    expect(REPLY_TO_QUESTION_LABEL).toBe("Reply to this question");
    expect(showReplyToQuestion({ allowCustomAnswer: false })).toBe(false);
    expect(showReplyToQuestion({})).toBe(true);
    expect(showReplyToQuestion({ allowCustomAnswer: true })).toBe(true);
  });

  it("reuses the assistant citation chip when the question is an assistant message", () => {
    const inserted = insert([
      {
        id: assistantMessageId,
        role: "assistant",
        text: `Context before. ${question} Context after.`,
      },
    ]);
    expect(inserted).toMatch(/^\[Assistant quote\]\(t3-citation:\/\/v1\//);
    const citation = collectAssistantCitations(inserted ?? "")[0]?.citation;
    expect(citation).toMatchObject({
      messageId: assistantMessageId,
      environmentId,
      threadId,
      text: question,
    });
    const received = projectPendingUserInputAnswer(inserted, []);
    expect(received).toContain("earlier assistant responses");
    expect(received).toContain(question);
    expect(received).not.toContain("t3-citation://");
  });

  // regression: a founder's own question must not reach the model as an Assistant quote
  it("does not describe a founder's own question as an assistant quote", () => {
    const inserted = insert([
      {
        id: assistantMessageId,
        role: "assistant",
        text: `Earlier the assistant asked: ${question}`,
      },
      {
        id: founderMessageId,
        role: "user",
        text: question,
      },
    ]);
    expect(inserted).toBe(`> Question:\n> ${question}\n\n`);
    expect(inserted).not.toContain("Assistant quote");
    expect(inserted).not.toContain("assistant-quote");
    expect(collectAssistantCitations(inserted ?? "")).toEqual([]);
    const received = projectPendingUserInputAnswer(inserted, []);
    expect(received).toBe(inserted);
    expect(expandAssistantCitationsForProvider(received as string)).not.toContain(
      "earlier assistant responses",
    );
  });

  it("quotes a question that is not stored on a message", () => {
    const inserted = insert([]);
    expect(inserted).toBe(`> Question:\n> ${question}\n\n`);
    expect(collectAssistantCitations(inserted ?? "")).toEqual([]);
  });

  it("keeps an existing assistant-quote link working", () => {
    const citation = parseAssistantCitationHref(legacyHref);
    expect(citation?.text).toBe("A quote & a newline.\n");
    const prompt = `[Assistant quote](${legacyHref})`;
    expect(collectAssistantCitations(prompt)).toHaveLength(1);
    expect(expandAssistantCitationsForProvider(prompt)).toContain("earlier assistant responses");
  });

  it("places a chip after the typed answer and a quote on its own paragraph", () => {
    const answer = "My answer";
    const chip = insert(
      [{ id: assistantMessageId, role: "assistant", text: question }],
      answer,
      answer.length,
    );
    expect(chip?.startsWith(" ")).toBe(true);
    expect(collectAssistantCitations(chip ?? "")).toHaveLength(1);

    const quote = insert([], answer, answer.length);
    expect(quote).toBe(`\n\n> Question:\n> ${question}\n\n`);
  });
});
