import { useState } from "react";
import { Markdown } from "./Markdown";
import {
  buildConversationTurns,
  splitThinking,
  toolCallsOf,
  type Conversation,
  type Turn,
} from "../lib/chat";
import { Brain, ChevronDown, FileCode, Wrench } from "lucide-react";

function MessageContent({ content }: { content: any }) {
  if (typeof content === "string") return <span className="whitespace-pre-wrap">{content}</span>;
  if (Array.isArray(content)) {
    return (
      <div className="space-y-2">
        {content.map((part: any, i: number) => {
          if (part?.type === "text") return <span key={i} className="whitespace-pre-wrap">{part.text}</span>;
          if (part?.type === "image_url") {
            return (
              <div key={i} className="mt-1.5 max-w-[160px] rounded-lg overflow-hidden border border-border/60">
                <img src={part.image_url?.url} alt="Attached" className="w-full h-auto" />
              </div>
            );
          }
          return null;
        })}
      </div>
    );
  }
  return <span className="font-mono text-[10px]">{JSON.stringify(content)}</span>;
}

/** Renders a logged conversation as a user/assistant thread, including
 *  reasoning ("thinking") and any tool calls / files the model produced. */
export function ConversationThread({ conv }: { conv: Conversation }) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpenKeys(prev => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  const { systemMsgs, turns } = buildConversationTurns(conv);

  return (
    <div className="rounded-xl border border-border/40 bg-background/30 p-4 space-y-3 overflow-hidden">
      {systemMsgs.map((msg: any, i: number) => (
        <div key={`sys-${i}`} className="w-full">
          <div className="text-[9px] font-bold uppercase tracking-widest text-amber-400/70 mb-1 px-1">System</div>
          <div className="px-3 py-2 bg-amber-500/5 border border-amber-500/15 rounded-lg text-muted-foreground/80 text-[11px]">
            <MessageContent content={msg.content} />
          </div>
        </div>
      ))}

      {turns.map((turn: Turn, ti: number) => {
        const a = turn.assistant;
        const split = a ? splitThinking(a.content, a.reasoning_content) : { thinking: "", text: "" };
        const tools = a ? toolCallsOf(a) : [];
        const thinkKey = `${conv.id}:${ti}:think`;
        const thinkOpen = openKeys.has(thinkKey);

        return (
          <div key={ti} className={`space-y-2 ${turn.isFinal ? "pt-2 border-t border-border/20" : ""}`}>
            {turn.user && (
              <div className="flex flex-col items-end">
                <div className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/60 mb-1 px-1">
                  Turn {turn.userTurn}
                </div>
                <div className="max-w-[85%] px-3.5 py-2.5 rounded-2xl rounded-br-md bg-indigo-600/20 border border-indigo-500/25 text-foreground/90 text-[11.5px]">
                  <MessageContent content={turn.user.content} />
                </div>
              </div>
            )}

            {a && (
              <div className="flex flex-col items-start w-full">
                <div className="flex items-center gap-1.5 mb-1.5 px-1">
                  <span className={`text-[9px] font-bold uppercase tracking-widest ${turn.isFinal ? "text-emerald-400" : "text-muted-foreground/60"}`}>
                    {turn.isFinal ? "Final Response" : "Assistant"}
                  </span>
                </div>

                {/* Reasoning accordion */}
                {split.thinking && (
                  <div className="w-full max-w-[85%] mb-2">
                    <button
                      onClick={() => toggle(thinkKey)}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-violet-500/8 border border-violet-500/20 hover:bg-violet-500/15 transition-all text-left"
                    >
                      <div className="w-5 h-5 rounded-md bg-violet-500/15 flex items-center justify-center flex-shrink-0">
                        <Brain className="w-3 h-3 text-violet-400" />
                      </div>
                      <span className="text-[10px] font-semibold text-violet-300 flex-1">Thinking Process</span>
                      <span className="text-[9px] text-violet-400/60 font-mono">{split.thinking.length.toLocaleString()} chars</span>
                      <ChevronDown className={`w-3.5 h-3.5 text-violet-400/60 transition-transform ${thinkOpen ? "rotate-180" : ""}`} />
                    </button>
                    {thinkOpen && (
                      <div className="mt-1.5 px-3.5 py-3 bg-violet-950/15 border border-violet-500/10 rounded-xl text-muted-foreground/80 max-h-[360px] overflow-y-auto">
                        <Markdown compact>{split.thinking}</Markdown>
                      </div>
                    )}
                  </div>
                )}

                {/* Visible answer */}
                {split.text && (
                  <div className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl rounded-bl-md text-[11.5px] ${turn.isFinal ? "bg-emerald-500/8 border border-emerald-500/20" : "bg-muted/40 border border-border/40"} text-foreground/90`}>
                    <Markdown compact>{split.text}</Markdown>
                  </div>
                )}

                {/* Tool calls / created files */}
                {tools.map((tc, i) => {
                  const isFile = !!(tc.path || tc.content);
                  const key = `${conv.id}:${ti}:tool:${i}`;
                  const open = openKeys.has(key);
                  return (
                    <div key={key} className="w-full max-w-[85%] mt-2">
                      <button
                        onClick={() => toggle(key)}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-sky-500/8 border border-sky-500/20 hover:bg-sky-500/15 transition-all text-left"
                      >
                        <div className="w-5 h-5 rounded-md bg-sky-500/15 flex items-center justify-center flex-shrink-0">
                          {isFile ? <FileCode className="w-3 h-3 text-sky-400" /> : <Wrench className="w-3 h-3 text-sky-400" />}
                        </div>
                        <span className="text-[10px] font-semibold text-sky-300 flex-1 truncate">
                          {isFile ? `File · ${tc.path || tc.name}` : `Tool · ${tc.name}`}
                        </span>
                        <ChevronDown className={`w-3.5 h-3.5 text-sky-400/60 transition-transform ${open ? "rotate-180" : ""}`} />
                      </button>
                      {open && (
                        <div className="mt-1.5 rounded-xl border border-sky-500/10 bg-background/50 overflow-hidden">
                          {tc.path && (
                            <div className="px-3 py-1.5 text-[10px] font-mono text-sky-300 border-b border-border/30 bg-sky-500/5 truncate">
                              {tc.path}
                            </div>
                          )}
                          <pre className="p-3 overflow-x-auto font-mono text-[10px] leading-normal text-muted-foreground/90 max-h-[400px] overflow-y-auto whitespace-pre-wrap">
                            {tc.content ?? tc.raw}
                          </pre>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
