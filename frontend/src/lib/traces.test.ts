import { describe, expect, test } from "bun:test";
import { parseTrace, detectTracePlatform, traceToConversation } from "./traces";
import { platformCategory, platformLabel, buildConversationTurns, toolCallsOf } from "./chat";

describe("platform categorization", () => {
  test("category buckets", () => {
    expect(platformCategory("")).toBe("chat");
    expect(platformCategory("chat")).toBe("chat");
    expect(platformCategory("vscode")).toBe("v1");
    expect(platformCategory("claude-code")).toBe("v1");
    expect(platformCategory("trace:claude-code")).toBe("trace");
    expect(platformCategory("trace")).toBe("trace");
    expect(platformCategory("pip-library")).toBe("pip-library");
  });
  test("labels strip the trace marker", () => {
    expect(platformLabel("trace:claude-code")).toBe("claude-code");
    expect(platformLabel("vscode")).toBe("vscode");
    expect(platformLabel("")).toBe("chat");
  });
});

describe("pi agent sessions", () => {
  const raw = [
    JSON.stringify({ type: "session", version: 3, id: "pi-1", cwd: "/workspace" }),
    JSON.stringify({ type: "model_change", provider: "rms", modelId: "Qwen3.6-35B" }),
    JSON.stringify({ type: "thinking_level_change", thinkingLevel: "off" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "write html" }] } }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "Writing." },
          { type: "toolCall", id: "call_9", name: "write", arguments: { path: "/x.html" } },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      message: { role: "toolResult", toolCallId: "call_9", toolName: "write", content: [{ type: "text", text: "wrote it" }] },
    }),
  ].join("\n");

  test("parses messages, reasoning, tool calls and tool results", () => {
    const t = parseTrace("s.jsonl", "s.jsonl", raw); // detected by content
    expect(t.ok).toBe(true);
    expect(t.platform).toBe("pi");
    expect(t.model).toBe("Qwen3.6-35B");
    expect(t.messages.map(m => m.role)).toEqual(["user", "assistant", "tool"]);
    const a = t.messages[1]!;
    expect(a.reasoning).toBe("plan");
    expect(a.tool_calls?.[0]?.id).toBe("call_9");
    expect(t.messages[2]).toEqual({ role: "tool", content: "wrote it", tool_call_id: "call_9", name: "write" });
  });
});

describe("command-code sessions", () => {
  const raw = [
    JSON.stringify({ id: "m1", sessionId: "cc-1", role: "user", content: [{ type: "text", text: "build it" }] }),
    JSON.stringify({
      id: "m2", sessionId: "cc-1", role: "assistant",
      content: [
        { type: "text", text: "On it." },
        { type: "tool-call", toolCallId: "call_1", toolName: "shell_command", input: { command: "bun init" } },
      ],
    }),
    JSON.stringify({
      id: "m3", sessionId: "cc-1", role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_1", toolName: "shell_command", output: { type: "text", value: "done" } }],
    }),
  ].join("\n");

  test("parses hyphenated tool blocks with linkage", () => {
    const t = parseTrace("cc-1.jsonl", "/x/command-code-pods/main/config/projects/w/cc-1.jsonl", raw);
    expect(t.ok).toBe(true);
    expect(t.platform).toBe("command-code");
    const a = t.messages[1]!;
    expect(a.tool_calls?.[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "shell_command", arguments: JSON.stringify({ command: "bun init" }) },
    });
    expect(t.messages[2]).toEqual({ role: "tool", content: "done", tool_call_id: "call_1", name: "shell_command" });
  });

  test("content sniffing distinguishes command-code from claude-code", () => {
    expect(detectTracePlatform("x.jsonl", raw)).toBe("command-code");
    const claude = JSON.stringify({ sessionId: "s", type: "user", message: { role: "user", content: "hi" } });
    expect(detectTracePlatform("x.jsonl", claude)).toBe("claude-code");
  });
});

describe("source capture (lossless upload)", () => {
  test("parseTrace keeps the original file byte-for-byte", () => {
    // Deliberately odd formatting: extra spaces, trailing newline, a non-JSON
    // line — none of it may be normalized away.
    const raw =
      '{ "message": { "role": "user",   "content": "hi" },  "uuid": "u-1" }\n' +
      "corrupted line that is not json\n" +
      '{"message":{"role":"assistant","content":"hello"}}\n';
    const t = parseTrace("s.jsonl", "/x/.claude/p/s.jsonl", raw);
    expect(t.ok).toBe(true);
    expect(t.source).toEqual({ format: "claude-code", kind: "jsonl", name: "s.jsonl", text: raw });
  });

  test("whole-JSON files are marked kind=json; unreadable files carry no source", () => {
    const raw = JSON.stringify({ model: "m", messages: [{ role: "user", content: "q" }] }, null, 2);
    expect(parseTrace("t.json", "t.json", raw).source?.kind).toBe("json");
    expect(parseTrace("empty.jsonl", "empty.jsonl", "").source).toBeUndefined();
  });
});

describe("traceToConversation (preview)", () => {
  test("rebuilds a previewable conversation with reasoning + tools", () => {
    const t = parseTrace(
      "s.jsonl",
      "/x/.claude/p/s.jsonl",
      [
        JSON.stringify({ message: { role: "user", content: "make a file" } }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "writing it" },
              { type: "text", text: "done" },
              { type: "tool_use", name: "write_file", input: { path: "a.txt", content: "hi" } },
            ],
          },
        }),
      ].join("\n"),
    );
    const conv = traceToConversation(t);
    const { turns } = buildConversationTurns(conv);
    expect(turns).toHaveLength(1);
    expect(turns[0].user.content).toBe("make a file");
    expect(turns[0].assistant.content).toBe("done");
    expect(turns[0].assistant.reasoning_content).toBe("writing it");
    expect(toolCallsOf(turns[0].assistant)[0].path).toBe("a.txt");
  });
});

describe("detectTracePlatform", () => {
  test("from path", () => {
    expect(detectTracePlatform("/Users/x/.claude/projects/abc/sess.jsonl", "")).toBe("claude-code");
    expect(detectTracePlatform("workspaceStorage/copilot/chat.json", "")).toBe("vscode");
    expect(detectTracePlatform("random.json", "")).toBe("trace");
  });
  test("from content hints", () => {
    expect(detectTracePlatform("x.jsonl", '{"sessionId":"a","cwd":"/p"}')).toBe("claude-code");
  });
});

describe("parseTrace", () => {
  test("OpenAI-style JSON with messages", () => {
    const text = JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "be nice" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    const t = parseTrace("chat.json", "chat.json", text);
    expect(t.ok).toBe(true);
    expect(t.model).toBe("gpt-4o");
    expect(t.messages.map(m => m.role)).toEqual(["system", "user", "assistant"]);
    expect(t.turnCount).toBe(1);
    expect(t.title).toBe("hi");
  });

  test("JSONL with nested message + content blocks (Claude Code style)", () => {
    const lines = [
      JSON.stringify({ type: "user", sessionId: "s1", cwd: "/p", message: { role: "user", content: "make a file" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus",
          content: [
            { type: "thinking", thinking: "I should write it" },
            { type: "text", text: "Sure, here it is." },
            { type: "tool_use", id: "tu1", name: "write_file", input: { path: "a.txt", content: "hi" } },
          ],
        },
      }),
    ].join("\n");
    const parsed = parseTrace("sess.jsonl", "/Users/x/.claude/projects/p/sess.jsonl", lines);
    expect(parsed.platform).toBe("claude-code");
    expect(parsed.model).toBe("claude-opus");
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1].role).toBe("assistant");
    expect(parsed.messages[1].content).toBe("Sure, here it is.");
    expect(parsed.messages[1].reasoning).toBe("I should write it");
    expect(parsed.messages[1].tool_calls?.[0].function.name).toBe("write_file");
    expect(JSON.parse(parsed.messages[1].tool_calls![0].function.arguments).path).toBe("a.txt");
  });

  test("ignores malformed JSONL lines but keeps valid ones", () => {
    const lines = ['{"role":"user","content":"q1"}', "not json", '{"role":"assistant","content":"a1"}'];
    const t = parseTrace("x.jsonl", "x.jsonl", lines.join("\n"));
    expect(t.messages.map(m => m.content)).toEqual(["q1", "a1"]);
  });

  test("empty / non-conversation file is not ok", () => {
    const t = parseTrace("x.json", "x.json", "{}");
    expect(t.ok).toBe(false);
    expect(t.error).toBeDefined();
  });

  test("VS Code / Copilot chat session format", () => {
    const session = {
      kind: 0,
      v: {
        version: 3,
        inputState: { selectedModel: { metadata: { family: "gpt-5.3-codex", name: "Auto", id: "auto" } } },
        requests: [
          { message: { text: "fix the docker compose" }, response: [{ value: "Sure, here's the plan:\n1. ..." }] },
          { message: { text: "now run it" }, response: [{ value: "Done." }] },
        ],
      },
    };
    const t = parseTrace(
      "129d09f4.jsonl",
      "/Code/User/workspaceStorage/abc/chatSessions/129d09f4.jsonl",
      JSON.stringify(session),
    );
    expect(t.ok).toBe(true);
    expect(t.platform).toBe("vscode");
    expect(t.model).toBe("gpt-5.3-codex");
    expect(t.messages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(t.messages[0].content).toBe("fix the docker compose");
    expect(t.messages[1].content).toContain("here's the plan");
    expect(t.turnCount).toBe(2);
  });

  test("empty VS Code session (no requests) is skipped", () => {
    const t = parseTrace("e.jsonl", "chatSessions/e.jsonl", JSON.stringify({ kind: 0, v: { requests: [] } }));
    expect(t.ok).toBe(false);
  });

  test("OpenAI Codex CLI rollout format", () => {
    const lines = [
      JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: "x", cwd: "/p" } }),
      JSON.stringify({ timestamp: "t", type: "turn_context", payload: { model: "gpt-5-codex" } }),
      JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] },
      }),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "looking" }] } }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call", name: "apply_patch", arguments: '{"path":"a.ts"}' },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed it." }] },
      }),
    ].join("\n");
    const t = parseTrace("rollout-2026.jsonl", "sessions/2026/06/rollout-2026.jsonl", lines);
    expect(t.ok).toBe(true);
    expect(t.platform).toBe("codex");
    expect(t.model).toBe("gpt-5-codex");
    expect(t.messages.find(m => m.role === "user")?.content).toBe("fix the bug");
    // function_call became an assistant tool call
    expect(t.messages.some(m => m.tool_calls?.[0]?.function?.name === "apply_patch")).toBe(true);
    // reasoning summary attached to the following assistant message
    expect(t.messages.find(m => m.role === "assistant" && m.content === "Fixed it.")?.reasoning).toBe("looking");
  });
});
