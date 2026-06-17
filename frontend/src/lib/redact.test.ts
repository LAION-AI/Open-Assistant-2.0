import { describe, expect, test } from "bun:test";
import { applyRedaction, placeholderFor, chunkText, redactMessages } from "./redact";

describe("placeholderFor", () => {
  test("normalizes entity groups", () => {
    expect(placeholderFor("private_email")).toBe("[REDACTED_EMAIL]");
    expect(placeholderFor("private_person")).toBe("[REDACTED_PERSON]");
    expect(placeholderFor("")).toBe("[REDACTED_PII]");
  });
});

describe("applyRedaction", () => {
  const text = "My name is Harry Potter and my email is harry.potter@hogwarts.edu.";

  test("redacts using char offsets", () => {
    // Offsets as openai/privacy-filter / transformers.js would return them.
    const nameStart = text.indexOf("Harry Potter");
    const emailStart = text.indexOf("harry.potter@hogwarts.edu");
    const entities = [
      { entity_group: "private_person", start: nameStart, end: nameStart + "Harry Potter".length },
      { entity_group: "private_email", start: emailStart, end: emailStart + "harry.potter@hogwarts.edu".length },
    ];
    const { text: out, count } = applyRedaction(text, entities);
    expect(count).toBe(2);
    expect(out).toBe("My name is [REDACTED_PERSON] and my email is [REDACTED_EMAIL].");
    expect(out).not.toContain("Harry");
    expect(out).not.toContain("hogwarts");
  });

  test("falls back to word replacement without offsets", () => {
    const entities = [
      { entity_group: "private_person", word: " Harry Potter" },
      { entity_group: "private_email", word: " harry.potter@hogwarts.edu" },
    ];
    const { text: out, count } = applyRedaction(text, entities);
    expect(count).toBe(2);
    expect(out).toContain("[REDACTED_PERSON]");
    expect(out).toContain("[REDACTED_EMAIL]");
  });

  test("no entities → unchanged", () => {
    expect(applyRedaction(text, []).text).toBe(text);
  });
});

describe("chunkText", () => {
  test("short text is a single chunk", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
  });
  test("long text splits and reassembles exactly", () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkText(long, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(long);
  });
});

describe("redactMessages", () => {
  test("redacts content and reasoning across a conversation", async () => {
    // Fake classifier returning a person entity for any text containing "Bob".
    const classifier = async (t: string) => {
      const i = t.indexOf("Bob");
      return i === -1 ? [] : [{ entity_group: "private_person", start: i, end: i + 3 }];
    };
    const { messages, count } = await redactMessages(
      [
        { role: "user", content: "Hi I am Bob" },
        { role: "assistant", content: "Hello", reasoning: "user Bob greeted me" },
      ],
      classifier,
    );
    expect(count).toBe(2);
    expect(messages[0].content).toBe("Hi I am [REDACTED_PERSON]");
    expect(messages[1].reasoning).toBe("user [REDACTED_PERSON] greeted me");
  });
});
