import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { ShieldCheck } from "lucide-react";
import { getRedactModel, setRedactModel, REDACT_MODELS, type RedactModel } from "../lib/redact";

const ORDER: RedactModel[] = ["rampart", "openai"];

export function RedactionSettings() {
  const [model, setModel] = useState<RedactModel>(() => getRedactModel());

  const choose = (m: RedactModel) => {
    setRedactModel(m);
    setModel(m);
  };

  return (
    <Card className="bg-gradient-to-br from-emerald-500/5 to-teal-500/5 bg-card/40 border border-emerald-500/25 shadow-xl overflow-hidden backdrop-blur-md animate-fade-in pt-0">
      <CardHeader className="border-b border-emerald-500/20 bg-emerald-500/10 pt-6">
        <CardTitle className="flex items-center gap-2 text-xl font-bold">
          <ShieldCheck className="w-5 h-5 text-emerald-400" />
          <span>PII Redaction Model</span>
        </CardTitle>
        <CardDescription className="text-xs leading-relaxed mt-1">
          Runs entirely on-device (WebGPU, falling back to CPU) to scrub names, emails, phone
          numbers and more — in chat and before traces are uploaded. Weights download once and are
          cached by your browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-3">
        {ORDER.map(m => {
          const meta = REDACT_MODELS[m];
          const active = model === m;
          return (
            <label
              key={m}
              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                active
                  ? "border-emerald-500/50 bg-emerald-500/10"
                  : "border-input bg-background/40 hover:bg-background/60"
              }`}
            >
              <input
                type="radio"
                name="redact-model"
                className="mt-1 accent-emerald-500"
                checked={active}
                onChange={() => choose(m)}
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground/90">
                  {meta.label}
                  {m === "rampart" && (
                    <span className="ml-2 text-[10px] font-medium uppercase tracking-wide text-emerald-400">
                      Default
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground leading-relaxed">{meta.note}</div>
              </div>
            </label>
          );
        })}
      </CardContent>
    </Card>
  );
}
