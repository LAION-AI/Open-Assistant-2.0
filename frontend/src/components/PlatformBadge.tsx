import { MessageSquare, Code, FileUp, Package } from "lucide-react";
import { platformCategory, platformLabel } from "../lib/chat";

const STYLES = {
  chat: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  v1: "text-sky-400 bg-sky-500/10 border-sky-500/20",
  trace: "text-violet-400 bg-violet-500/10 border-violet-500/20",
  "pip-library": "text-amber-400 bg-amber-500/10 border-amber-500/20",
} as const;

const ICONS = { chat: MessageSquare, v1: Code, trace: FileUp, "pip-library": Package } as const;

/** Colored badge showing a conversation's origin category + label. */
export function PlatformBadge({ platform }: { platform: string | undefined }) {
  const cat = platformCategory(platform);
  const Icon = ICONS[cat];
  return (
    <div className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border flex-shrink-0 ${STYLES[cat]}`}>
      <Icon className="w-3 h-3" />
      <span>{platformLabel(platform)}</span>
    </div>
  );
}
