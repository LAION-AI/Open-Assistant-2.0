// Server-side SQLite trace extractors (bun:sqlite) for agents that store
// sessions in a database rather than JSONL files. Each returns preview-able
// trace objects in the same shape as lib/traces.ts parseTrace, including a
// verbatim-rows source envelope for lossless back-conversion.

import { Database } from "bun:sqlite";

// Parse a Charm Crush database (<project>/.crush/crush.db): messages carry a
// JSON `parts` array of typed blocks (text / reasoning / tool_call / tool_result).
export function parseCrushDb(dbPath: string): any[] {
  const db = new Database(dbPath, { readwrite: true });
  try {
    const sessions = db.query("SELECT id, title FROM sessions ORDER BY created_at").all() as any[];
    const traces: any[] = [];
    for (const s of sessions) {
      const rows = db
        .query("SELECT id, role, parts, model FROM messages WHERE session_id = ? ORDER BY created_at ASC")
        .all(s.id) as any[];
      const messages: any[] = [];
      let model = "";
      const sourceLines: string[] = [JSON.stringify({ table: "session", row: s })];
      for (const r of rows) {
        let parts: any[] = [];
        try {
          parts = JSON.parse(r.parts);
        } catch {}
        sourceLines.push(JSON.stringify({ table: "message", id: r.id, role: r.role, model: r.model, parts }));
        if (!model && r.model) model = r.model;
        const text: string[] = [];
        const reasoning: string[] = [];
        const tools: any[] = [];
        const results: any[] = [];
        for (const part of Array.isArray(parts) ? parts : []) {
          const d = part?.data || {};
          if (part?.type === "text" && d.text) text.push(d.text);
          else if (part?.type === "reasoning" && d.thinking) reasoning.push(d.thinking);
          else if (part?.type === "tool_call") {
            tools.push({
              ...(d.id ? { id: d.id } : {}),
              type: "function",
              function: {
                name: d.name || "tool",
                arguments: typeof d.input === "string" ? d.input : JSON.stringify(d.input ?? {}),
              },
            });
          } else if (part?.type === "tool_result") {
            const tm: any = {
              role: "tool",
              content: typeof d.content === "string" ? d.content : JSON.stringify(d.content ?? ""),
            };
            if (d.tool_call_id) tm.tool_call_id = d.tool_call_id;
            if (d.name) tm.name = d.name;
            results.push(tm);
          }
        }
        if (text.length || reasoning.length || tools.length) {
          const nm: any = { role: r.role, content: text.join("\n") };
          if (reasoning.length) nm.reasoning = reasoning.join("\n");
          if (tools.length) nm.tool_calls = tools;
          messages.push(nm);
        }
        messages.push(...results);
      }
      const filtered = messages.filter(m => m.role === "tool" || m.content || m.tool_calls?.length || m.reasoning);
      if (!filtered.some(m => m.role === "user" || m.role === "assistant")) continue;
      const firstUser = filtered.find(m => m.role === "user");
      const title = ((s.title || firstUser?.content || "Crush session") as string).replace(/\s+/g, " ").slice(0, 80);
      traces.push({
        ok: true,
        fileName: s.id,
        platform: "crush",
        model,
        messages: filtered,
        turnCount: Math.max(filtered.filter(m => m.role === "user").length, 1),
        title,
        source: { format: "crush", kind: "jsonl", name: `${s.id}.jsonl`, text: sourceLines.join("\n") },
      });
    }
    return traces;
  } finally {
    db.close();
  }
}

// Parse a Hermes agent database (~/.hermes/state.db): messages use near-OpenAI
// columns (content, tool_calls JSON, reasoning_content, tool linkage).
export function parseHermesDb(dbPath: string): any[] {
  const db = new Database(dbPath, { readwrite: true });
  try {
    const sessions = db.query("SELECT id, model, title FROM sessions ORDER BY started_at").all() as any[];
    const traces: any[] = [];
    for (const s of sessions) {
      const rows = db
        .query(
          "SELECT id, role, content, tool_call_id, tool_calls, tool_name, reasoning, reasoning_content FROM messages WHERE session_id = ? ORDER BY id ASC",
        )
        .all(s.id) as any[];
      const messages: any[] = [];
      const sourceLines: string[] = [JSON.stringify({ table: "session", row: s })];
      for (const r of rows) {
        sourceLines.push(JSON.stringify({ table: "message", row: r }));
        let role = r.role;
        if (role === "toolResult" || role === "tool_response") role = "tool";
        if (!["system", "user", "assistant", "tool"].includes(role)) continue;
        const nm: any = { role, content: r.content || "" };
        const reasoning = r.reasoning_content || r.reasoning;
        if (reasoning) nm.reasoning = reasoning;
        if (r.tool_calls) {
          try {
            const calls = JSON.parse(r.tool_calls);
            if (Array.isArray(calls) && calls.length) {
              nm.tool_calls = calls.map((tc: any) => ({
                ...(tc?.id ? { id: tc.id } : {}),
                type: "function",
                function: {
                  name: tc?.function?.name || tc?.name || "tool",
                  arguments:
                    typeof tc?.function?.arguments === "string"
                      ? tc.function.arguments
                      : JSON.stringify(tc?.function?.arguments ?? {}),
                },
              }));
            }
          } catch {}
        }
        if (role === "tool") {
          if (r.tool_call_id) nm.tool_call_id = r.tool_call_id;
          if (r.tool_name) nm.name = r.tool_name;
        }
        messages.push(nm);
      }
      const filtered = messages.filter(m => m.role === "tool" || m.content || m.tool_calls?.length || m.reasoning);
      if (!filtered.some(m => m.role === "user" || m.role === "assistant")) continue;
      const firstUser = filtered.find(m => m.role === "user");
      const title = ((s.title || firstUser?.content || "Hermes session") as string).replace(/\s+/g, " ").slice(0, 80);
      traces.push({
        ok: true,
        fileName: s.id,
        platform: "hermes",
        model: s.model || "",
        messages: filtered,
        turnCount: Math.max(filtered.filter(m => m.role === "user").length, 1),
        title,
        source: { format: "hermes", kind: "jsonl", name: `${s.id}.jsonl`, text: sourceLines.join("\n") },
      });
    }
    return traces;
  } finally {
    db.close();
  }
}
