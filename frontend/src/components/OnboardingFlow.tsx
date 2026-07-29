import { useState, type ReactNode } from "react";
import { Dialog, DialogContent } from "./ui/dialog";
import { Button } from "./ui/button";
import {
  Sparkles,
  MessageSquare,
  Network,
  Boxes,
  ShieldCheck,
  Trophy,
  ArrowRight,
  ArrowLeft,
  Check,
} from "lucide-react";

interface Step {
  icon: ReactNode;
  tint: string; // tailwind colour stem, e.g. "indigo"
  title: string;
  lead: string;
  points: string[];
  cta?: { label: string; tab: string };
}

const STEPS: Step[] = [
  {
    icon: <Sparkles className="w-7 h-7" />,
    tint: "indigo",
    title: "Welcome to Open Assistant 2.0",
    lead: "You're helping build an openly licensed dataset of real human–AI interaction, for training open frontier models.",
    points: [
      "Everything you contribute is yours to review and delete at any time",
      "You choose what gets shared — nothing is collected silently",
      "Takes about a minute to set up",
    ],
  },
  {
    icon: <MessageSquare className="w-7 h-7" />,
    tint: "violet",
    title: "Chat, and the conversation counts",
    lead: "Talk to a model straight from the Chat tab. Each exchange becomes a contribution you control.",
    points: [
      "Bring your own endpoint, or use the built-in models",
      "Multi-turn threads stay grouped as one conversation",
      "Redact anything sensitive before it's stored",
    ],
    cta: { label: "Open Chat", tab: "chat" },
  },
  {
    icon: <Network className="w-7 h-7" />,
    tint: "amber",
    title: "Route your coding tools through the proxy",
    lead: "Point VS Code Copilot, Claude Code, opencode or Codex at your personal proxy endpoint and their sessions are captured automatically.",
    points: [
      "One personal API key, generated in Settings",
      "Works with anything that speaks the OpenAI API",
      "Your key is shown once and stored only as a hash",
    ],
    cta: { label: "Get my API key", tab: "settings-v1proxy" },
  },
  {
    icon: <Boxes className="w-7 h-7" />,
    tint: "sky",
    title: "Already have history? Upload it",
    lead: "Import existing sessions from the tools you use — we detect the format and find them on your machine.",
    points: [
      "Claude Code, Copilot Chat, OpenCode, Codex, Antigravity and more",
      "We show you the exact folder for your operating system",
      "Review every conversation before anything is uploaded",
    ],
    cta: { label: "Import traces", tab: "uploads" },
  },
  {
    icon: <ShieldCheck className="w-7 h-7" />,
    tint: "emerald",
    title: "Privacy stays on your device",
    lead: "A small AI model scrubs names, emails, keys and other personal details in your browser — before anything is sent.",
    points: [
      "Redaction runs locally; the raw text never leaves your machine",
      "On by default for trace uploads",
      "Choose between a fast lightweight model or a broader one in Settings",
    ],
  },
  {
    icon: <Trophy className="w-7 h-7" />,
    tint: "rose",
    title: "Secure your account, then you're set",
    lead: "Passkeys are the safest way in. If you sign in with a password instead, turn on two-factor authentication.",
    points: [
      "Passkeys can't be phished and need nothing to remember",
      "Password accounts: add an authenticator app in Settings",
      "Opt into the leaderboard if you'd like your contributions counted publicly",
    ],
    cta: { label: "Open Settings", tab: "settings" },
  },
];

const TINTS: Record<string, { ring: string; bg: string; text: string; btn: string }> = {
  indigo: { ring: "ring-indigo-500/30", bg: "bg-indigo-500/15", text: "text-indigo-400", btn: "bg-indigo-600 hover:bg-indigo-700" },
  violet: { ring: "ring-violet-500/30", bg: "bg-violet-500/15", text: "text-violet-400", btn: "bg-violet-600 hover:bg-violet-700" },
  amber: { ring: "ring-amber-500/30", bg: "bg-amber-500/15", text: "text-amber-400", btn: "bg-amber-600 hover:bg-amber-700" },
  sky: { ring: "ring-sky-500/30", bg: "bg-sky-500/15", text: "text-sky-400", btn: "bg-sky-600 hover:bg-sky-700" },
  emerald: { ring: "ring-emerald-500/30", bg: "bg-emerald-500/15", text: "text-emerald-400", btn: "bg-emerald-600 hover:bg-emerald-700" },
  rose: { ring: "ring-rose-500/30", bg: "bg-rose-500/15", text: "text-rose-400", btn: "bg-rose-600 hover:bg-rose-700" },
};

interface Props {
  open: boolean;
  username?: string;
  onFinish: () => void;
  onNavigate: (tab: string) => void;
}

export function OnboardingFlow({ open, username, onFinish, onNavigate }: Props) {
  const [index, setIndex] = useState(0);
  const step = STEPS[index]!;
  const tint = TINTS[step.tint]!;
  const isLast = index === STEPS.length - 1;

  const go = (tab: string) => {
    onNavigate(tab);
    onFinish();
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onFinish()}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-lg bg-card/95 backdrop-blur-xl border-border/80 rounded-2xl p-0"
      >
        {/* Progress */}
        <div className="flex gap-1.5 px-4 sm:px-6 pt-4 sm:pt-6">
          {STEPS.map((s, i) => (
            <div
              key={s.title}
              className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                i <= index ? "bg-foreground/70" : "bg-foreground/15"
              }`}
            />
          ))}
        </div>

        <div className="px-4 sm:px-6 pb-4 sm:pb-6 pt-4 sm:pt-5 space-y-4 sm:space-y-5">
          <div className={`w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex items-center justify-center ring-1 ${tint.bg} ${tint.ring} ${tint.text}`}>
            {step.icon}
          </div>

          <div className="space-y-2">
            <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight leading-tight">
              {index === 0 && username ? `Welcome, ${username}` : step.title}
            </h2>
            <p className="text-sm text-muted-foreground leading-relaxed">{step.lead}</p>
          </div>

          <ul className="space-y-2">
            {step.points.map(p => (
              <li key={p} className="flex items-start gap-2.5 text-[13px] leading-relaxed">
                <Check className={`w-4 h-4 flex-shrink-0 mt-0.5 ${tint.text}`} />
                <span className="text-foreground/85">{p}</span>
              </li>
            ))}
          </ul>

          {step.cta && (
            <button
              onClick={() => go(step.cta!.tab)}
              className={`text-xs font-semibold ${tint.text} hover:underline flex items-center gap-1.5`}
            >
              {step.cta.label} <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/50">
            <button
              onClick={onFinish}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {isLast ? "Close" : "Skip for now"}
            </button>

            <div className="flex items-center gap-1.5 sm:gap-2">
              {index > 0 && (
                <Button variant="ghost" onClick={() => setIndex(i => i - 1)} className="h-9 rounded-lg text-xs gap-1.5">
                  <ArrowLeft className="w-3.5 h-3.5" /> Back
                </Button>
              )}
              <Button
                onClick={() => (isLast ? onFinish() : setIndex(i => i + 1))}
                className={`h-9 rounded-lg text-xs font-semibold text-white gap-1.5 ${tint.btn}`}
              >
                {isLast ? "Start contributing" : "Next"}
                {!isLast && <ArrowRight className="w-3.5 h-3.5" />}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
