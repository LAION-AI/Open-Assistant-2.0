import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

interface MarkdownProps {
  children: string;
  /** Slightly tighter styling for dense contexts like the admin log. */
  compact?: boolean;
}

/**
 * Renders assistant/markdown text with GitHub-flavored markdown support
 * (bold, lists, tables, code fences, links). Falls back gracefully on plain
 * text. Styling is kept self-contained so it reads well inside chat bubbles
 * on both the light user bubble and the dark assistant bubble.
 */
export const Markdown = memo(function Markdown({ children, compact }: MarkdownProps) {
  const size = compact ? "text-[11.5px]" : "text-sm";
  return (
    <div
      className={`markdown-body ${size} leading-relaxed break-words [&_p]:my-1.5 first:[&_p]:mt-0 last:[&_p]:mb-0`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{
          a: ({ node, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 underline underline-offset-2 hover:text-indigo-300"
            />
          ),
          ul: ({ node, ...props }) => (
            <ul {...props} className="my-1.5 ml-4 list-disc space-y-1 marker:text-muted-foreground/60" />
          ),
          ol: ({ node, ...props }) => (
            <ol {...props} className="my-1.5 ml-4 list-decimal space-y-1 marker:text-muted-foreground/60" />
          ),
          li: ({ node, ...props }) => <li {...props} className="pl-0.5" />,
          h1: ({ node, ...props }) => <h1 {...props} className="mt-3 mb-1.5 text-base font-bold" />,
          h2: ({ node, ...props }) => <h2 {...props} className="mt-3 mb-1.5 text-[15px] font-bold" />,
          h3: ({ node, ...props }) => <h3 {...props} className="mt-2.5 mb-1 text-sm font-bold" />,
          strong: ({ node, ...props }) => <strong {...props} className="font-semibold" />,
          blockquote: ({ node, ...props }) => (
            <blockquote
              {...props}
              className="my-2 border-l-2 border-border/70 pl-3 italic text-muted-foreground"
            />
          ),
          hr: ({ node, ...props }) => <hr {...props} className="my-3 border-border/50" />,
          code: ({ node, className, children, ...props }: any) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code
                  {...props}
                  className="rounded bg-black/25 px-1.5 py-0.5 font-mono text-[0.85em] text-foreground/90"
                >
                  {children}
                </code>
              );
            }
            return (
              <code {...props} className={`${className} font-mono text-[0.85em]`}>
                {children}
              </code>
            );
          },
          pre: ({ node, ...props }) => (
            <pre
              {...props}
              className="my-2 overflow-x-auto rounded-lg border border-border/40 bg-black/30 p-3 text-[0.8rem] leading-relaxed"
            />
          ),
          table: ({ node, ...props }) => (
            <div className="my-2 overflow-x-auto">
              <table {...props} className="w-full border-collapse text-[0.85em]" />
            </div>
          ),
          th: ({ node, ...props }) => (
            <th {...props} className="border border-border/50 bg-muted/40 px-2 py-1 text-left font-semibold" />
          ),
          td: ({ node, ...props }) => (
            <td {...props} className="border border-border/40 px-2 py-1 align-top" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
