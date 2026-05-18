import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendGenerationTailMessages,
  buildUserMessageRegenerationInstruction,
  buildUserMessageRegenerationPrompt,
} from "../packages/server/src/routes/generate/generate-route-utils.ts";

describe("user message regeneration instruction", () => {
  it("asks the provider to rewrite the user message as a swipe", () => {
    const instruction = buildUserMessageRegenerationInstruction({ content: "try again" });

    assert.match(instruction, /Regenerate the user's previous message as an alternate swipe/);
    assert.match(instruction, /Write only the replacement user message text/);
    assert.match(instruction, /Do not answer as the assistant/);
    assert.match(instruction, /<original_user_message>\ntry again\n<\/original_user_message>/);
  });

  it("trims original user message whitespace", () => {
    const instruction = buildUserMessageRegenerationInstruction({ content: "  padded message  " });

    assert.match(instruction, /<original_user_message>\npadded message\n<\/original_user_message>/);
  });

  it("includes readable attachments when rebuilding a user-message regeneration prompt", () => {
    const prompt = buildUserMessageRegenerationPrompt({
      content: "summarize this",
      extra: JSON.stringify({
        attachments: [
          {
            type: "text/plain",
            filename: "notes.txt",
            data: "data:text/plain;base64,TGluZSAxCkxpbmUgMg==",
          },
        ],
      }),
    });

    assert.equal(prompt.role, "user");
    assert.match(prompt.content, /<original_user_message>\nsummarize this/);
    assert.match(prompt.content, /<attached_file name="notes.txt" type="text\/plain">/);
    assert.match(prompt.content, /Line 1\nLine 2/);
  });

  it("preserves image attachments when rebuilding a user-message regeneration prompt", () => {
    const imageDataUrl = "data:image/png;base64,aW1hZ2U=";
    const prompt = buildUserMessageRegenerationPrompt({
      content: "what is in this image?",
      extra: {
        attachments: [
          {
            type: "image/png",
            filename: "image.png",
            data: imageDataUrl,
          },
        ],
      },
    });

    assert.deepEqual(prompt.images, [imageDataUrl]);
  });

  it("keeps Gemini user-message regeneration as the final user turn while preserving assistant prefill", () => {
    const messages = [{ role: "user" as const, content: "context" }];
    const imageDataUrl = "data:image/png;base64,aW1hZ2U=";
    const regenerateUserMessage = buildUserMessageRegenerationPrompt({
      content: "Regenerate the user message",
      extra: {
        attachments: [
          {
            type: "image/png",
            data: imageDataUrl,
          },
        ],
      },
    });

    appendGenerationTailMessages(messages, {
      assistantPrefill: "Assistant prefill test:",
      followUpIteration: 0,
      impersonate: false,
      isGoogleProvider: true,
      regenerateUserMessage,
    });

    assert.deepEqual(messages.slice(-2), [
      { role: "assistant", content: "Assistant prefill test:" },
      regenerateUserMessage,
    ]);
    assert.deepEqual(messages.at(-1)?.images, [imageDataUrl]);
  });

  it("keeps assistant prefill as the final assistant turn outside Gemini user-message regeneration", () => {
    const messages = [{ role: "user" as const, content: "context" }];

    appendGenerationTailMessages(messages, {
      assistantPrefill: "Continue from here:",
      followUpIteration: 0,
      impersonate: false,
      isGoogleProvider: false,
      regenerateUserMessage: buildUserMessageRegenerationPrompt({ content: "Regenerate the user message" }),
    });

    assert.deepEqual(messages.slice(-1), [{ role: "assistant", content: "Continue from here:" }]);
  });
});
