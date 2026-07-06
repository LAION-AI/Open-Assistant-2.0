import { useState, useMemo, useRef, useEffect } from "react";
import { Markdown } from "./Markdown";
import {
  buildConversationTurns,
  splitThinking,
  toolCallsOf,
  type Conversation,
  type Turn,
} from "../lib/chat";
import { Brain, ChevronDown, FileCode, Wrench } from "lucide-react";

// Render in chunks so huge conversations (thousands of turns) don't lock up the
// browser — more turns load as you scroll. Individual giant messages are also
// truncated on screen (the full text is still stored/uploaded).
const CHUNK = 20;
const TEXT_CAP = 8000;
const PRE_CAP = 50000;

function MessageContent({ content }: { content: any }) {
  if (typeof content === "string") {
    const long = content.length > TEXT_CAP;
    return (
      <span className="whitespace-pre-wrap break-words">
        {long ? content.slice(0, TEXT_CAP) : content}
        {long && <span className="text-muted-foreground/50"> …(+{(content.length - TEXT_CAP).toLocaleString()} chars)</span>}
      </span>
    );
  }
  if (Array.isArray(content)) {
    return (
      <div className="space-y-2">
        {content.map((part: any, i: number) => {
          if (part?.type === "text") return <MessageContent key={i} content={part.text} />;
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

  // Memoize — rebuilding thousands of turns on every toggle would be wasteful.
  const { systemMsgs, turns } = useMemo(() => buildConversationTurns(conv), [conv]);

  const [visible, setVisible] = useState(() => Math.min(CHUNK, turns.length));
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Auto-load the next chunk when the sentinel scrolls into view.
  useEffect(() => {
    if (visible >= turns.length) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting) setVisible(v => Math.min(v + CHUNK, turns.length));
      },
      { rootMargin: "300px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [visible, turns.length]);

  const shown = turns.slice(0, visible);
  const remaining = turns.length - visible;

  return (
    <div className="rounded-xl border border-border/40 bg-background/30 p-4 space-y-3 overflow-hidden">
      {turns.length > CHUNK && (
        <div className="text-[10px] text-muted-foreground/70 pb-1">
          Showing {Math.min(visible, turns.length).toLocaleString()} of {turns.length.toLocaleString()} turns
        </div>
      )}

      {systemMsgs.map((msg: any, i: number) => (
        <div key={`sys-${i}`} className="w-full">
          <div className="text-[9px] font-bold uppercase tracking-widest text-amber-400/70 mb-1 px-1">System</div>
          <div className="px-3 py-2 bg-amber-500/5 border border-amber-500/15 rounded-lg text-muted-foreground/80 text-[11px]">
            <MessageContent content={msg.content} />
          </div>
        </div>
      ))}

      {shown.map((turn: Turn, ti: number) => {
        const a = turn.assistant;
        const split = a ? splitThinking(a.content, a.reasoning_content) : { thinking: "", text: "" };
        const tools = a ? toolCallsOf(a) : [];
        const thinkKey = `${conv.id}:${ti}:think`;
        const thinkOpen = openKeys.has(thinkKey);
        const textKey = `${conv.id}:${ti}:text`;
        const longText = split.text.length > TEXT_CAP;
        const textExpanded = openKeys.has(textKey);
        const displayText = longText && !textExpanded ? split.text.slice(0, TEXT_CAP) : split.text;

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
                        <Markdown compact>{split.thinking.slice(0, PRE_CAP)}</Markdown>
                      </div>
                    )}
                  </div>
                )}

                {/* Visible answer */}
                {split.text && (
                  <div className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl rounded-bl-md text-[11.5px] ${turn.isFinal ? "bg-emerald-500/8 border border-emerald-500/20" : "bg-muted/40 border border-border/40"} text-foreground/90`}>
                    <Markdown compact>{displayText}</Markdown>
                    {longText && (
                      <button onClick={() => toggle(textKey)} className="mt-1 text-[10px] text-indigo-400 hover:underline">
                        {textExpanded ? "Show less" : `Show full message (${split.text.length.toLocaleString()} chars)`}
                      </button>
                    )}
                  </div>
                )}

                {/* Tool calls / created files */}
                {tools.map((tc, i) => {
                  const isFile = !!(tc.path || tc.content);
                  const key = `${conv.id}:${ti}:tool:${i}`;
                  const open = openKeys.has(key);
                  const body = (tc.content ?? tc.raw) || "";
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
                            {body.slice(0, PRE_CAP)}
                            {body.length > PRE_CAP && `\n…(+${(body.length - PRE_CAP).toLocaleString()} chars)`}
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

      {/* Load-more sentinel (auto) + manual fallback */}
      {remaining > 0 && (
        <div ref={sentinelRef} className="pt-2">
          <button
            onClick={() => setVisible(v => Math.min(v + CHUNK, turns.length))}
            className="w-full py-2 rounded-xl border border-border/50 bg-muted/30 hover:bg-muted/50 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
          >
            Load {Math.min(CHUNK, remaining)} more ({remaining.toLocaleString()} remaining)
          </button>
        </div>
      )}
    </div>
  );
}
