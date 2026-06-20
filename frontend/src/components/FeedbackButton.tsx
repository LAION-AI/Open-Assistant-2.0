import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { MessageSquarePlus, Loader2, CheckCircle, AlertCircle } from "lucide-react";

/** Header button that lets any logged-in user send feedback / suggestions. */
export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!message.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Failed to send feedback");
      }
      setDone(true);
      setMessage("");
      setTimeout(() => {
        setOpen(false);
        setDone(false);
      }, 1100);
    } catch (e: any) {
      setError(e.message || "Failed to send");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        onClick={() => setOpen(true)}
        className="h-9 w-9 rounded-xl border-border/80 text-muted-foreground hover:text-foreground hover:bg-muted"
        title="Send feedback"
      >
        <MessageSquarePlus className="w-4 h-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Send feedback</DialogTitle>
            <DialogDescription>
              What could be better? Bugs, ideas, criticism — all welcome. It goes straight to the maintainers.
            </DialogDescription>
          </DialogHeader>

          <Textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder="Your feedback…"
            className="min-h-[140px] resize-none rounded-xl"
            autoFocus
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
            }}
          />

          {error && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertCircle className="w-3.5 h-3.5" />
              <span>{error}</span>
            </div>
          )}

          <DialogFooter className="sm:justify-between sm:items-center">
            <span className="text-[10px] text-muted-foreground/70 hidden sm:block">⌘/Ctrl + Enter to send</span>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setOpen(false)} className="rounded-xl">
                Cancel
              </Button>
              <Button
                onClick={submit}
                disabled={!message.trim() || sending || done}
                className="rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white gap-2"
              >
                {done ? <CheckCircle className="w-4 h-4" /> : sending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                <span>{done ? "Sent!" : sending ? "Sending…" : "Send feedback"}</span>
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
