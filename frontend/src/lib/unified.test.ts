import { describe, expect, test } from "bun:test";
import {
  UNIFIED_SCHEMA,
  normalizeMessages,
  buildStoredPayload,
  toStored,
  storedToMessages,
  toChatCompletions,
  sourceOf,
  sourceFileName,
  type SourceEnvelope,
  type UnifiedMessage,
} from "./unified";

describe("normalizeMessages", () => {
  test("passes through plain chat-completions messages", () => {
    const out = normalizeMessages([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", reasoning_content: "greeting" },
    ]);
    expect(out).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", reasoning_content: "greeting" },
    ]);
  });

  test("accepts the pip-proxy `reasoning` alias and tool shapes", () => {
    const out = normalizeMessages([
      {
        role: "assistant",
        content: "",
        reasoning: "let me check",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
      },
      { role: "tool", content: "file body", tool_call_id: "c1", name: "read" },
    ]);
    expect(out[0]!.reasoning_content).toBe("let me check");
    expect(out[0]!.tool_calls![0]!.id).toBe("c1");
    expect(out[1]).toEqual({ role: "tool", content: "file body", tool_call_id: "c1", name: "read" });
  });

  test("flattens Anthropic-style blocks and splits tool_result into tool messages", () => {
    const out = normalizeMessages([
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "running" },
          { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
      { role: "assistant", content: "done" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: "running",
        reasoning_content: "plan",
        tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
      },
      { role: "tool", content: "a.txt", tool_call_id: "t1" },
      { role: "assistant", content: "done" },
    ]);
  });

  test("collects images from image_url blocks, image field, and base64 sources", () => {
    const out = normalizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBB" } },
        ],
      },
      { role: "user", content: "and this", image: "https://x/y.png" },
    ]);
    expect(out[0]!.images).toEqual(["data:image/png;base64,AAA", "data:image/jpeg;base64,BBB"]);
    expect(out[1]!.images).toEqual(["https://x/y.png"]);
  });

  test("is deterministic (reproducible): same input, same output bytes", () => {
    const input = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a", tool_calls: [{ function: { name: "t", arguments: { x: 1 } } }] },
    ];
    const a = buildStoredPayload("m", input);
    const b = buildStoredPayload("m", input);
    expect(a).toEqual(b);
  });
});

describe("stored payload", () => {
  test("stamps the schema and splits the final assistant turn", () => {
    const { prompt, response, tokens } = buildStoredPayload("gpt", [
      { role: "user", content: "2+2?" },
      { role: "assistant", content: "4", reasoning: "math" },
    ]);
    const p = JSON.parse(prompt);
    expect(p.schema).toBe(UNIFIED_SCHEMA);
    expect(p.model).toBe("gpt");
    expect(p.messages).toEqual([{ role: "user", content: "2+2?" }]);
    expect(JSON.parse(response)).toEqual({ role: "assistant", content: "4", reasoning_content: "math" });
    expect(tokens).toBeGreaterThan(0);
  });

  test("storedToMessages reassembles the full conversation (back-conversion)", () => {
    const source = [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", content: "out", tool_call_id: "c1" },
      { role: "assistant", content: "a", reasoning_content: "r" },
    ];
    const { prompt, response } = toStored("m", source);
    expect(storedToMessages(prompt, response)).toEqual(source as UnifiedMessage[]);
  });

  test("storedToMessages handles legacy rows (multimodal arrays, JSON strings)", () => {
    const legacyPrompt = JSON.stringify({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "see image" },
            { type: "image_url", image_url: { url: "data:x" } },
          ],
        },
      ],
    });
    const legacyResponse = JSON.stringify({ role: "assistant", content: "nice", reasoning_content: "" });
    expect(storedToMessages(legacyPrompt, legacyResponse)).toEqual([
      { role: "user", content: "see image", images: ["data:x"] },
      { role: "assistant", content: "nice" },
    ]);
  });
});

describe("toChatCompletions (provider back-conversion)", () => {
  test("re-expands images and keeps tool linkage", () => {
    const unified: UnifiedMessage[] = [
      { role: "user", content: "look", images: ["data:x"] },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", content: "out", tool_call_id: "c1", name: "t" },
      { role: "assistant", content: "a", reasoning_content: "r" },
    ];
    expect(toChatCompletions(unified)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:x" } },
        ],
      },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", content: "out", tool_call_id: "c1", name: "t" },
      { role: "assistant", content: "a", reasoning_content: "r" },
    ]);
  });
});

describe("source envelope (lossless back-conversion)", () => {
  const jsonl = [
    '{"sessionId":"s1","type":"user","message":{"role":"user","content":"hi"},"cwd":"/tmp","uuid":"u-1"}',
    "not json — kept verbatim anyway",
    '{"sessionId":"s1","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]},"uuid":"u-2"}',
  ].join("\n");
  const source: SourceEnvelope = { format: "claude-code", kind: "jsonl", name: "session.jsonl", text: jsonl };
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];

  test("rides along in the stored prompt, byte-for-byte", () => {
    const { prompt } = toStored("m", messages, source);
    expect(prompt.source).toEqual(source);
    // Survives the actual JSON serialization used for storage.
    expect(sourceOf(JSON.stringify(prompt))?.text).toBe(jsonl);
  });

  test("sourceOf reconstructs the envelope from a stored row", () => {
    const { prompt } = toStored("m", messages, source);
    const back = sourceOf(prompt);
    expect(back).toEqual(source);
    expect(sourceFileName(back!)).toBe("session.jsonl");
  });

  test("sourceFileName falls back to format + kind", () => {
    expect(sourceFileName({ format: "codex", kind: "jsonl", text: "x" })).toBe("codex.jsonl");
    expect(sourceFileName({ format: "vscode", kind: "json", text: "x" })).toBe("vscode.json");
  });

  test("does not inflate the token estimate", () => {
    const withSource = toStored("m", messages, { ...source, text: "x".repeat(100_000) });
    const withoutSource = toStored("m", messages);
    expect(withSource.tokens).toBe(withoutSource.tokens);
  });

  test("is omitted when absent or empty", () => {
    expect(toStored("m", messages).prompt.source).toBeUndefined();
    expect(toStored("m", messages, { format: "x", kind: "jsonl", text: "" }).prompt.source).toBeUndefined();
    expect(sourceOf({ model: "m", messages: [] })).toBeNull();
  });

  test("storedToMessages is unaffected by the envelope", () => {
    const { prompt, response } = toStored("m", messages, source);
    expect(storedToMessages(prompt, response)).toEqual(messages as UnifiedMessage[]);
  });
});
