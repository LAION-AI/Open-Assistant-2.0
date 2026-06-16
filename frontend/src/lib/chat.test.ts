import { describe, expect, test } from "bun:test";
import {
  splitThinking,
  getMessages,
  getTurnCount,
  messageText,
  getLastUserMessage,
  truncateText,
  hasThinking,
  buildTurns,
  messageSignature,
  isPrefix,
  groupConversations,
  buildConversationTurns,
  conversationHasThinking,
  conversationToMessages,
  conversationTitle,
  toolCallsOf,
  type InteractionLog,
} from "./chat";

// Build a logged row the way the Go proxy stores it.
function makeLog(
  id: number,
  userId: string,
  createdAt: number,
  messages: any[],
  answer: { content: string; reasoning?: string },
  conversationId?: string,
): InteractionLog {
  return {
    id,
    userId,
    conversationId,
    createdAt,
    tokens: 10 * id,
    prompt: JSON.stringify({ model: "gemma", messages, stream: true }),
    response: JSON.stringify({
      role: "assistant",
      content: answer.content,
      reasoning_content: answer.reasoning || "",
    }),
  };
}

describe("splitThinking", () => {
  test("returns plain text when there is no reasoning", () => {
    expect(splitThinking("The answer is a frog.")).toEqual({
      thinking: "",
      text: "The answer is a frog.",
    });
  });

  test("uses dedicated reasoning field", () => {
    expect(splitThinking("Answer.", "let me think")).toEqual({
      thinking: "let me think",
      text: "Answer.",
    });
  });

  test("extracts a closed inline <think> block", () => {
    expect(splitThinking("<think>hmm a frog</think>The answer is a frog.")).toEqual({
      thinking: "hmm a frog",
      text: "The answer is a frog.",
    });
  });

  test("treats an unclosed <think> block (mid-stream) as thinking", () => {
    expect(splitThinking("<think>still reasoning")).toEqual({
      thinking: "still reasoning",
      text: "",
    });
  });

  test("merges reasoning field with an inline block", () => {
    const { thinking, text } = splitThinking("<think>b</think>done", "a");
    expect(thinking).toBe("a\nb");
    expect(text).toBe("done");
  });

  test("non-string content yields empty text", () => {
    expect(splitThinking([{ type: "text", text: "hi" }], "r")).toEqual({
      thinking: "r",
      text: "",
    });
  });
});

describe("getMessages / getTurnCount", () => {
  const prompt = JSON.stringify({
    model: "gemma",
    messages: [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ],
  });

  test("parses the messages array from a request payload", () => {
    const msgs = getMessages(prompt);
    expect(msgs).toHaveLength(3);
    expect(msgs?.[0].content).toBe("q1");
  });

  test("returns null for non-JSON prompts", () => {
    expect(getMessages("just a raw string")).toBeNull();
  });

  test("accepts an already-parsed object prompt (new backend format)", () => {
    const obj = { model: "gemma", messages: [{ role: "user", content: "hi" }] };
    expect(getMessages(obj)).toHaveLength(1);
    expect(getLastUserMessage(obj)).toBe("hi");
  });

  test("counts user messages as turns", () => {
    expect(getTurnCount(getMessages(prompt))).toBe(2);
  });

  test("defaults to a single turn when unparseable", () => {
    expect(getTurnCount(null)).toBe(1);
  });
});

describe("messageText", () => {
  test("passes strings through", () => {
    expect(messageText("hello")).toBe("hello");
  });

  test("pulls the text part out of multimodal content", () => {
    expect(
      messageText([
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "data:..." } },
      ]),
    ).toBe("describe this");
  });

  test("labels image-only content", () => {
    expect(messageText([{ type: "image_url", image_url: { url: "x" } }])).toBe(
      "[Multimodal content]",
    );
  });
});

describe("getLastUserMessage", () => {
  test("returns the most recent user message", () => {
    const prompt = JSON.stringify({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "latest" },
      ],
    });
    expect(getLastUserMessage(prompt)).toBe("latest");
  });

  test("falls back to the raw prompt when not JSON", () => {
    expect(getLastUserMessage("raw")).toBe("raw");
  });
});

describe("truncateText", () => {
  test("leaves short text untouched", () => {
    expect(truncateText("short", 80)).toBe("short");
  });

  test("appends an ellipsis when over the limit", () => {
    expect(truncateText("abcdef", 3)).toBe("abc…");
  });
});

describe("hasThinking", () => {
  test("true when reasoning_content is present", () => {
    expect(hasThinking(JSON.stringify({ content: "a", reasoning_content: "r" }))).toBe(true);
  });

  test("true when content has an inline <think> block", () => {
    expect(hasThinking(JSON.stringify({ content: "<think>x</think>a" }))).toBe(true);
  });

  test("false for a plain answer", () => {
    expect(hasThinking(JSON.stringify({ content: "a", reasoning_content: "" }))).toBe(false);
  });
});

describe("buildTurns", () => {
  test("pairs a single user message with the final response", () => {
    const messages = [{ role: "user", content: "riddle" }];
    const { systemMsgs, turns } = buildTurns(messages, { content: "a frog", reasoning: "" });
    expect(systemMsgs).toHaveLength(0);
    expect(turns).toHaveLength(1);
    expect(turns[0].user.content).toBe("riddle");
    expect(turns[0].assistant.content).toBe("a frog");
    expect(turns[0].isFinal).toBe(true);
    expect(turns[0].userTurn).toBe(1);
  });

  test("reconstructs a multi-turn conversation", () => {
    const messages = [
      { role: "system", content: "be nice" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ];
    const { systemMsgs, turns } = buildTurns(messages, { content: "a2", reasoning: "thinking" });

    expect(systemMsgs.map(m => m.content)).toEqual(["be nice"]);
    expect(turns).toHaveLength(2);

    expect(turns[0].user.content).toBe("q1");
    expect(turns[0].assistant.content).toBe("a1");
    expect(turns[0].isFinal).toBe(false);
    expect(turns[0].userTurn).toBe(1);

    expect(turns[1].user.content).toBe("q2");
    expect(turns[1].assistant.content).toBe("a2");
    expect(turns[1].assistant.reasoning_content).toBe("thinking");
    expect(turns[1].isFinal).toBe(true);
    expect(turns[1].userTurn).toBe(2);
  });

  test("handles an empty/unparseable conversation", () => {
    const { systemMsgs, turns } = buildTurns(null, null);
    expect(systemMsgs).toHaveLength(0);
    expect(turns).toHaveLength(0);
  });
});

describe("isPrefix / messageSignature", () => {
  test("signature captures role and text", () => {
    const sig = messageSignature(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
    expect(sig).toEqual([{ role: "user", text: "hi" }]);
  });

  test("prefix relationship", () => {
    const a = [{ role: "user", text: "q1" }];
    const b = [
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "q2" },
    ];
    expect(isPrefix(a, b)).toBe(true);
    expect(isPrefix(b, a)).toBe(false);
    expect(isPrefix([{ role: "user", text: "other" }], b)).toBe(false);
  });
});

describe("groupConversations", () => {
  // A 2-turn chat: turn 1 logs one row, turn 2 logs a row whose prompt
  // includes turn 1's answer + the new question.
  const t1 = makeLog(1, "user-a", 100, [{ role: "user", content: "q1" }], {
    content: "a1",
    reasoning: "thinking about q1",
  });
  const t2 = makeLog(
    2,
    "user-a",
    200,
    [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ],
    { content: "a2", reasoning: "thinking about q2" },
  );

  test("folds turn rows of one chat into a single conversation", () => {
    const convs = groupConversations([t1, t2]);
    expect(convs).toHaveLength(1);
    expect(convs[0].logs).toHaveLength(2);
    expect(convs[0].id).toBe(2); // representative = latest row
    expect(convs[0].turnCount).toBe(2);
    expect(convs[0].createdAt).toBe(100);
    expect(convs[0].updatedAt).toBe(200);
    expect(convs[0].totalTokens).toBe(30); // 10 + 20
  });

  test("ingestion order does not matter", () => {
    expect(groupConversations([t2, t1])).toHaveLength(1);
  });

  test("separate users never merge", () => {
    const other = makeLog(3, "user-b", 150, [{ role: "user", content: "q1" }], { content: "x" });
    const convs = groupConversations([t1, t2, other]);
    expect(convs).toHaveLength(2);
  });

  test("two distinct chats from one user stay separate", () => {
    const otherChat = makeLog(5, "user-a", 300, [{ role: "user", content: "totally different" }], {
      content: "z",
    });
    const convs = groupConversations([t1, t2, otherChat]);
    expect(convs).toHaveLength(2);
    expect(convs[0].updatedAt).toBe(300); // newest first
  });
});

describe("groupConversations with conversationId (bulletproof)", () => {
  test("groups strictly by id, ignoring message content", () => {
    const a1 = makeLog(1, "user-a", 100, [{ role: "user", content: "hello" }], { content: "hi" }, "conv-A");
    const a2 = makeLog(
      2,
      "user-a",
      200,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "more" },
      ],
      { content: "sure" },
      "conv-A",
    );
    const convs = groupConversations([a1, a2]);
    expect(convs).toHaveLength(1);
    expect(convs[0].logs).toHaveLength(2);
    expect(convs[0].turnCount).toBe(2);
  });

  test("identical first messages stay separate when ids differ", () => {
    // The exact case the heuristic could not disambiguate.
    const a = makeLog(1, "user-a", 100, [{ role: "user", content: "hello" }], { content: "x" }, "conv-A");
    const b = makeLog(2, "user-a", 110, [{ role: "user", content: "hello" }], { content: "y" }, "conv-B");
    const convs = groupConversations([a, b]);
    expect(convs).toHaveLength(2);
  });

  test("same id but different users never merge", () => {
    const a = makeLog(1, "user-a", 100, [{ role: "user", content: "q" }], { content: "x" }, "shared");
    const b = makeLog(2, "user-b", 110, [{ role: "user", content: "q" }], { content: "y" }, "shared");
    expect(groupConversations([a, b])).toHaveLength(2);
  });

  test("mixes id-based and legacy heuristic grouping", () => {
    const idA = makeLog(1, "user-a", 100, [{ role: "user", content: "q1" }], { content: "a1" }, "conv-A");
    const legacy1 = makeLog(2, "user-b", 150, [{ role: "user", content: "q" }], { content: "a" });
    const legacy2 = makeLog(
      3,
      "user-b",
      160,
      [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        { role: "user", content: "q2" },
      ],
      { content: "a2" },
    );
    const convs = groupConversations([idA, legacy1, legacy2]);
    expect(convs).toHaveLength(2); // idA alone + the two folded legacy rows
  });
});

describe("buildConversationTurns", () => {
  const t1 = makeLog(1, "user-a", 100, [{ role: "user", content: "q1" }], {
    content: "a1",
    reasoning: "reasoning-1",
  });
  const t2 = makeLog(
    2,
    "user-a",
    200,
    [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1", reasoning_content: "reasoning-1" },
      { role: "user", content: "q2" },
    ],
    { content: "a2", reasoning: "reasoning-2" },
  );

  test("preserves thinking for EVERY turn, not just the final one", () => {
    const [conv] = groupConversations([t1, t2]);
    const { turns } = buildConversationTurns(conv);

    expect(turns).toHaveLength(2);

    // Turn 1: reasoning backfilled from its own logged row (history stripped it).
    expect(turns[0].user.content).toBe("q1");
    expect(turns[0].assistant.content).toBe("a1");
    expect(turns[0].assistant.reasoning_content).toBe("reasoning-1");
    expect(turns[0].isFinal).toBe(false);

    // Turn 2: the final answer, with its own reasoning.
    expect(turns[1].user.content).toBe("q2");
    expect(turns[1].assistant.content).toBe("a2");
    expect(turns[1].assistant.reasoning_content).toBe("reasoning-2");
    expect(turns[1].isFinal).toBe(true);
  });

  test("conversationHasThinking reflects any turn", () => {
    const [conv] = groupConversations([t1, t2]);
    expect(conversationHasThinking(conv)).toBe(true);
  });
});

describe("conversation reconstruction for reload", () => {
  const t1 = makeLog(1, "user-a", 100, [{ role: "user", content: "q1" }], {
    content: "a1",
    reasoning: "r1",
  }, "conv-A");
  const t2 = makeLog(
    2,
    "user-a",
    200,
    [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1", reasoning_content: "r1" },
      { role: "user", content: "q2" },
    ],
    { content: "a2", reasoning: "r2" },
    "conv-A",
  );

  test("conversationToMessages produces an alternating, reasoning-preserving thread", () => {
    const [conv] = groupConversations([t1, t2]);
    const msgs = conversationToMessages(conv);
    expect(msgs.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs[0]).toMatchObject({ role: "user", content: "q1" });
    expect(msgs[1]).toMatchObject({ role: "assistant", content: "a1", reasoning: "r1" });
    expect(msgs[3]).toMatchObject({ role: "assistant", content: "a2", reasoning: "r2" });
  });

  test("conversationToMessages keeps an attached image on a user turn", () => {
    const withImg = makeLog(
      9,
      "user-a",
      50,
      [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,XYZ" } },
          ],
        },
      ],
      { content: "a cat" },
      "conv-img",
    );
    const [conv] = groupConversations([withImg]);
    const msgs = conversationToMessages(conv);
    expect(msgs[0]).toMatchObject({ role: "user", content: "what is this", image: "data:image/png;base64,XYZ" });
  });

  test("conversationTitle uses the first user message", () => {
    const [conv] = groupConversations([t1, t2]);
    expect(conversationTitle(conv)).toBe("q1");
  });
});

describe("tool calls / created files", () => {
  test("toolCallsOf surfaces a created file's path and content", () => {
    const msg = {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "spinning-cube.html", content: "<html>cube</html>" }),
          },
        },
      ],
    };
    const tools = toolCallsOf(msg);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("write_file");
    expect(tools[0].path).toBe("spinning-cube.html");
    expect(tools[0].content).toBe("<html>cube</html>");
  });

  test("toolCallsOf keeps raw arguments when not valid JSON", () => {
    const tools = toolCallsOf({
      tool_calls: [{ function: { name: "f", arguments: "{not json" } }],
    });
    expect(tools[0].args).toBeNull();
    expect(tools[0].raw).toBe("{not json");
  });

  test("buildConversationTurns carries tool_calls into the final turn", () => {
    const row: InteractionLog = {
      id: 1,
      userId: "u",
      conversationId: "c1",
      createdAt: 1,
      tokens: 5,
      prompt: { messages: [{ role: "user", content: "make a file" }] },
      response: {
        role: "assistant",
        content: "done",
        tool_calls: [{ function: { name: "write_file", arguments: '{"path":"a.txt","content":"hi"}' } }],
      },
    };
    const [conv] = groupConversations([row]);
    const { turns } = buildConversationTurns(conv);
    const tools = toolCallsOf(turns[0].assistant);
    expect(tools[0].path).toBe("a.txt");
    expect(tools[0].content).toBe("hi");
  });
});
