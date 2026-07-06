import { useState, useEffect, type FormEvent } from "react";
import { registerPasskey, authenticatePasskey, isPasskeySupported } from "./lib/auth";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { AdminPanel } from "./components/AdminPanel";
import { UploadsPanel } from "./components/UploadsPanel";
import { HomePanel } from "./components/HomePanel";
import { ThemeToggle } from "./components/ThemeToggle";
import { FeedbackButton } from "./components/FeedbackButton";
import { EmailAuth } from "./components/EmailAuth";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import {
  Server,
  MessageSquare,
  Settings,
  LogOut,
  Coins,
  Shield,
  Fingerprint,
  Sparkles,
  HelpCircle,
  ShieldAlert,
  Boxes,
  Home,
} from "lucide-react";
import logo from "./logo.svg";
import "./index.css";

interface User {
  id: string;
  username: string;
  email?: string | null;
  credits: number;
  byoeUrl?: string | null;
  byoeKey?: string | null;
  byoeModel?: string | null;
  hasApiKey?: boolean;
  emailVerified?: number;
  hasPassword?: boolean;
  hasPasskey?: boolean;
  isAdmin: number;
  showInLeaderboard?: number;
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authUsername, setAuthUsername] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"home" | "chat" | "uploads" | "settings" | "admin">("home");
  const [settingsSubTab, setSettingsSubTab] = useState<"byoe" | "v1proxy" | "pyproxy">("byoe");
  const [passkeySupported, setPasskeySupported] = useState(true);
  const [isRegistering, setIsRegistering] = useState(false);

  const fetchUser = async () => {
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
      } else {
        setUser(null);
      }
    } catch (err) {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUser();
    isPasskeySupported().then(supported => {
      setPasskeySupported(supported);
    });
  }, []);

  const handleNavigate = (tab: string) => {
    if (tab.startsWith("settings-")) {
      const sub = tab.substring(9) as "byoe" | "v1proxy" | "pyproxy";
      setActiveTab("settings");
      setSettingsSubTab(sub);
    } else if (tab === "settings") {
      setActiveTab("settings");
      setSettingsSubTab("byoe");
    } else {
      setActiveTab(tab as any);
    }
  };

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    if (!authUsername.trim() || authUsername.trim().length < 3) {
      setAuthError("Please enter a username with at least 3 characters.");
      return;
    }

    setAuthError(null);
    setAuthLoading(true);

    const res = await registerPasskey(authUsername.trim());
    setAuthLoading(false);

    if (res.error) {
      setAuthError(res.error);
    } else if (res.verified) {
      setUser(res.user);
    }
  };

  const handleLogin = async () => {
    setAuthError(null);
    setAuthLoading(true);

    const res = await authenticatePasskey();
    setAuthLoading(false);

    if (res.error) {
      setAuthError(res.error);
    } else if (res.verified) {
      setUser(res.user);
    }
  };

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) {
        setUser(null);
        setActiveTab("chat");
      }
    } catch (err) {
      console.error("Logout failed:", err);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin"></div>
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Synchronizing adapter session...
          </span>
        </div>
      </div>
    );
  }

  // Not authenticated view (Sign in / Register)
  if (!user) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center px-4 relative z-10 py-12">
        <Card className="w-full max-w-md bg-card/40 backdrop-blur-md border border-border/80 shadow-2xl rounded-2xl overflow-hidden">
          <CardHeader className="text-center pb-4 pt-8 border-b border-border/50 bg-card/30">
            <img src={logo} alt="Open Assistant Logo" className="h-16 w-auto mx-auto mb-4 hover:scale-105 transition-all duration-300" />
            <CardTitle className="text-3xl font-extrabold tracking-tight">Open Assistant 2.0</CardTitle>
            <CardDescription className="text-xs leading-relaxed max-w-xs mx-auto mt-2">
              Crowdsource interaction data for open frontier models. Sign in passwordless via secure platform passkeys.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            {!passkeySupported && (
              <div className="p-3 bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[11px] rounded-xl flex items-start gap-2.5 leading-relaxed">
                <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>
                  <strong>Passkeys not supported:</strong> Your current browser/device environment does not support platform authenticators or conditional UI. Fallback prompts will activate.
                </span>
              </div>
            )}

            {authError && (
              <div className="p-3 bg-destructive/10 border border-destructive/20 text-destructive text-xs rounded-xl flex items-start gap-2.5 leading-relaxed">
                <Shield className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{authError}</span>
              </div>
            )}

            {!isRegistering ? (
              <div className="space-y-4">
                <Button
                  type="button"
                  onClick={handleLogin}
                  disabled={authLoading}
                  className="w-full h-12 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold shadow-lg shadow-indigo-600/15 flex items-center justify-center gap-2 transition-all duration-300 transform hover:scale-[1.01]"
                >
                  <Fingerprint className="w-5 h-5 text-indigo-200" />
                  <span>{authLoading ? "Initializing authenticator..." : "Sign in with Passkey"}</span>
                </Button>
                <p className="text-center text-[10px] text-emerald-400/80 -mt-1">Recommended — phishing-resistant, nothing to leak</p>

                <div className="text-center pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsRegistering(true);
                      setAuthError(null);
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  >
                    Don't have an account? Register a new username
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleRegister} className="space-y-4 animate-fade-in">
                <div className="space-y-1.5">
                  <Label htmlFor="username" className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground px-1">
                    Choose Username
                  </Label>
                  <Input
                    id="username"
                    type="text"
                    value={authUsername}
                    onChange={e => setAuthUsername(e.target.value)}
                    placeholder="Enter username to register"
                    disabled={authLoading}
                    className="h-11 bg-background/50 border-input rounded-xl text-sm"
                    autoComplete="username webauthn"
                    autoFocus
                  />
                </div>

                <Button
                  type="submit"
                  disabled={authLoading}
                  className="w-full h-11 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold shadow-lg shadow-indigo-600/10"
                >
                  {authLoading ? "Initializing authenticator..." : "Register Passkey"}
                </Button>

                <div className="text-center pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsRegistering(false);
                      setAuthError(null);
                      setAuthUsername("");
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  >
                    Already have an account? Sign in
                  </button>
                </div>
              </form>
            )}

            {/* Email + password (alternative to passkeys) */}
            <EmailAuth onAuthed={setUser} />
          </CardContent>
          <div className="px-6 py-4 bg-muted/30 border-t border-border/50 text-center text-[10px] text-muted-foreground/80 leading-relaxed flex items-center justify-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
            <span>Phishing-resistant passwordless WebAuthn logic</span>
          </div>
        </Card>
      </div>
    );
  }

  // Authenticated Dashboard view
  return (
    // Pinned to the viewport (not `w-full`) so the body's content-sized grid
    // column can't make the layout widen as streamed text grows.
    <div className="fixed inset-0 flex flex-col z-10 overflow-hidden">
      {/* Header bar */}
      <header className="w-full border-b border-border/80 bg-background/30 backdrop-blur-md z-50 flex-shrink-0">
        <div className="w-full px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={logo} alt="Open Assistant Logo" className="h-8 w-auto" />
            <span className="font-extrabold text-base tracking-tight hidden sm:block">
              Open Assistant 2.0
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted border border-border/50 text-xs font-semibold text-muted-foreground">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span>{user.username}</span>
            </div>

            {/* Navigation Tabs */}
            <div className="flex items-center bg-muted/65 p-1 rounded-xl border border-border/40">
              <Button
                variant={activeTab === "home" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("home")}
                className="h-8 rounded-lg px-3 text-xs gap-1.5 font-semibold"
              >
                <Home className="w-3.5 h-3.5" />
                <span>Home</span>
              </Button>
              <Button
                variant={activeTab === "chat" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("chat")}
                className="h-8 rounded-lg px-3 text-xs gap-1.5 font-semibold"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>Chat</span>
              </Button>
              <Button
                variant={activeTab === "uploads" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("uploads")}
                className="h-8 rounded-lg px-3 text-xs gap-1.5 font-semibold"
              >
                <Boxes className="w-3.5 h-3.5" />
                <span>Uploads</span>
              </Button>
              <Button
                variant={activeTab === "settings" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("settings")}
                className="h-8 rounded-lg px-3 text-xs gap-1.5 font-semibold"
              >
                <Settings className="w-3.5 h-3.5" />
                <span>Settings</span>
              </Button>
              {user.isAdmin === 1 && (
                <Button
                  variant={activeTab === "admin" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setActiveTab("admin")}
                  className="h-8 rounded-lg px-3 text-xs gap-1.5 font-semibold"
                >
                  <Shield className="w-3.5 h-3.5" />
                  <span>Admin</span>
                </Button>
              )}
            </div>

            <FeedbackButton />

            <ThemeToggle />

            <Button
              variant="outline"
              size="icon"
              onClick={handleLogout}
              className="h-9 w-9 rounded-xl border-border/80 hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
              title="Logout session"
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Main Container — chat fills the viewport; other tabs scroll centered */}
      {activeTab === "chat" ? (
        <main className="flex-1 min-h-0 w-full max-w-[1400px] mx-auto px-3 sm:px-4 py-4">
          <ChatPanel user={user} onRefreshUser={fetchUser} />
        </main>
      ) : (
        <main className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-4xl w-full mx-auto px-4 py-8">
             {activeTab === "home" ? (
              <HomePanel onNavigate={handleNavigate} />
            ) : activeTab === "uploads" ? (
              <UploadsPanel />
            ) : activeTab === "settings" ? (
              <SettingsPanel user={user} onUpdateUser={(u) => setUser(u)} subTab={settingsSubTab} onSubTabChange={setSettingsSubTab} />
            ) : (
              <AdminPanel />
            )}
          </div>
          <footer className="w-full py-4 text-center text-[10px] text-muted-foreground/60 border-t border-border/30 bg-background/10">
            Open Assistant 2.0 — Crowdsourcing secure interaction dataset for public model training.
          </footer>
        </main>
      )}
    </div>
  );
}

export default App;
