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
import { OnboardingFlow } from "./components/OnboardingFlow";
import { SecurityBanner } from "./components/SecurityBanner";
import { LegalPage, LegalFooter } from "./components/LegalPage";
import { TermsUpdateBanner } from "./components/TermsUpdateBanner";
import { PublicationCountdown } from "./components/PublicationCountdown";
import { ConsentCheckboxes, EMPTY_CONSENT, type ConsentState } from "./components/ConsentCheckboxes";
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
  twoFactorEnabled?: boolean;
  twoFactorMethod?: string | null;
  backupCodesRemaining?: number;
  onboarded?: boolean;
  termsCurrent?: boolean;
  datasetConsent?: number;
  datasetConsentCurrent?: boolean;
}

// The legal pages are real URLs so they can be linked to from outside the app
// (and from the Impressum obligation's point of view, found without an
// account). The server serves index.html for any path, so routing is just a
// matter of reading it back.
const LEGAL_PATHS = ["impressum", "privacy", "terms"];
function slugFromPath(pathname: string): string | null {
  const slug = pathname.replace(/^\/+|\/+$/g, "");
  return LEGAL_PATHS.includes(slug) ? slug : null;
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
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [legalSlug, setLegalSlug] = useState<string | null>(() => slugFromPath(window.location.pathname));
  const [signupConsent, setSignupConsent] = useState<ConsentState>(EMPTY_CONSENT);
  // Passkeys are the default. Email + password is a deliberate detour the user
  // has to choose, not a second option sitting next to it — it costs them a 2FA
  // setup before they can upload, which passkeys give for free.
  //
  // Exception: a password-reset link lands on /?reset=<token>, which is a
  // password flow by definition. Mount email straight away in that case, or the
  // link would open a passkey screen with no way through.
  // Bumped after an upload or a deletion so the publication countdown re-reads
  // instead of showing a figure that is one action out of date.
  const [contributionsChanged, setContributionsChanged] = useState(0);
  const [emailPath, setEmailPath] = useState<"none" | "login" | "register">(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("reset")
      ? "login"
      : "none"
  );

  const fetchUser = async () => {
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        if (data.user && !data.user.onboarded) setShowOnboarding(true);
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

  // Keep the legal view in step with browser back/forward.
  useEffect(() => {
    const onPop = () => setLegalSlug(slugFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const closeLegal = () => {
    window.history.pushState({}, "", "/");
    setLegalSlug(null);
  };

  const finishOnboarding = async () => {
    setShowOnboarding(false);
    try {
      await fetch("/api/user/onboarded", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done: true }),
      });
      setUser(u => (u ? { ...u, onboarded: true } : u));
    } catch {
      // Non-fatal: the flow is dismissed locally either way.
    }
  };

  const handleNavigate = (tab: string) => {
    if (tab === "settings-security") {
      setActiveTab("settings");
      // Let Settings render before scrolling to the anchor.
      setTimeout(() => document.getElementById("two-factor")?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
      return;
    }
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
    if (!signupConsent.acceptedTerms || !signupConsent.datasetConsent) {
      setAuthError(
        "Both required boxes must be ticked: the terms, and that contributed data may be published."
      );
      return;
    }

    setAuthError(null);
    setAuthLoading(true);

    const res = await registerPasskey(authUsername.trim(), signupConsent);
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

  // Before the session check: a legal page must render even while /api/auth/me
  // is in flight, and whether or not anyone is signed in.
  if (legalSlug) {
    return <LegalPage slug={legalSlug} onBack={closeLegal} />;
  }

  if (loading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background text-foreground">
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
      <div className="min-h-[100dvh] w-full min-w-0 flex items-center justify-center overflow-x-hidden px-3 sm:px-4 relative z-10 py-6 sm:py-12">
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

                <div className="text-center pt-2 space-y-2">
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
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        setEmailPath("login");
                        setAuthError(null);
                      }}
                      className="text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer"
                    >
                      Sign in with email and password instead
                    </button>
                  </div>
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

                <ConsentCheckboxes
                  value={signupConsent}
                  onChange={setSignupConsent}
                  disabled={authLoading}
                />

                <Button
                  type="submit"
                  disabled={authLoading || !signupConsent.acceptedTerms || !signupConsent.datasetConsent}
                  className="w-full h-11 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold shadow-lg shadow-indigo-600/10 disabled:opacity-50"
                >
                  {authLoading ? "Initializing authenticator..." : "Register Passkey"}
                </Button>

                <div className="text-center pt-2 space-y-2.5">
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

                  <div className="pt-1 border-t border-border/40">
                    <button
                      type="button"
                      onClick={() => {
                        setEmailPath("register");
                        setAuthError(null);
                      }}
                      className="mt-2.5 text-[11px] text-muted-foreground/80 hover:text-foreground transition-colors cursor-pointer leading-relaxed"
                    >
                      Register with email and password instead
                    </button>
                    <p className="text-[10px] text-muted-foreground/60 leading-relaxed mt-1">
                      Needs two-factor authentication set up before your first trace upload.
                      A passkey already counts as two factors.
                    </p>
                  </div>
                </div>
              </form>
            )}

            {/* Email + password: only on screen once the user asks for it. */}
            {emailPath !== "none" && (
              <EmailAuth
                onAuthed={setUser}
                startMode={emailPath}
                showDivider={false}
                onExit={() => setEmailPath("none")}
              />
            )}
          </CardContent>
          <div className="px-6 py-4 bg-muted/30 border-t border-border/50 text-center text-[10px] text-muted-foreground/80 leading-relaxed space-y-2">
            <div className="flex items-center justify-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
              <span>Phishing-resistant passwordless WebAuthn logic</span>
            </div>
            <LegalFooter />
          </div>
        </Card>
      </div>
    );
  }

  const navItems = [
    { tab: "home" as const, label: "Home", icon: Home },
    { tab: "chat" as const, label: "Chat", icon: MessageSquare },
    { tab: "uploads" as const, label: "Uploads", icon: Boxes },
    { tab: "settings" as const, label: "Settings", icon: Settings },
    ...(user.isAdmin === 1
      ? [{ tab: "admin" as const, label: "Admin", icon: Shield }]
      : []),
  ];

  // Authenticated Dashboard view
  return (
    <div className="fixed inset-0 h-[100dvh] w-full max-w-full min-w-0 flex flex-col z-10 overflow-hidden overscroll-none">
      {/* Header bar */}
      <header className="w-full border-b border-border/80 bg-background/30 backdrop-blur-md z-50 flex-shrink-0">
        <div className="w-full min-w-0 px-3 sm:px-4 h-14 md:h-16 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <img src={logo} alt="Open Assistant Logo" className="h-8 w-auto" />
            <span className="font-extrabold text-base tracking-tight hidden sm:block">
              Open Assistant 2.0
            </span>
          </div>

          <div className="flex min-w-0 items-center gap-2 md:gap-3">
            <PublicationCountdown
              refreshKey={contributionsChanged}
              onNavigate={handleNavigate}
            />

            <div className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted border border-border/50 text-xs font-semibold text-muted-foreground">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span>{user.username}</span>
            </div>

            {/* Navigation Tabs */}
            <nav aria-label="Primary navigation" className="hidden lg:flex items-center bg-muted/65 p-1 rounded-xl border border-border/40">
              {navItems.map(({ tab, label, icon: Icon }) => (
                <Button
                  key={tab}
                  variant={activeTab === tab ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setActiveTab(tab)}
                  className="h-8 rounded-lg px-3 text-xs gap-1.5 font-semibold"
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </Button>
              ))}
            </nav>

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

      {/* Nudge password accounts without a second factor towards Settings. */}
      <SecurityBanner user={user} onNavigate={handleNavigate} />

      <TermsUpdateBanner user={user} onAccepted={fetchUser} />

      <OnboardingFlow
        open={showOnboarding}
        username={user.username}
        onFinish={finishOnboarding}
        onNavigate={handleNavigate}
      />

      {/* Main Container — chat fills the viewport; other tabs scroll centered */}
      {activeTab === "chat" ? (
        <main className="flex-1 min-h-0 min-w-0 w-full max-w-[1400px] mx-auto p-2 sm:px-4 sm:py-4">
          <ChatPanel user={user} onRefreshUser={fetchUser} />
        </main>
      ) : (
        <main className="flex-1 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain">
          <div className="max-w-4xl min-w-0 w-full mx-auto px-3 sm:px-4 py-4 sm:py-8">
             {activeTab === "home" ? (
              <HomePanel onNavigate={handleNavigate} />
            ) : activeTab === "uploads" ? (
              <UploadsPanel
                uploadBlocked={!user.hasPasskey && !user.twoFactorEnabled}
                onContributionsChanged={() => setContributionsChanged(n => n + 1)}
              />
            ) : activeTab === "settings" ? (
              <SettingsPanel user={user} onUpdateUser={(u) => setUser(u)} subTab={settingsSubTab} onSubTabChange={setSettingsSubTab} />
            ) : (
              <AdminPanel />
            )}
          </div>
          <footer className="w-full py-4 text-center text-[10px] text-muted-foreground/60 border-t border-border/30 bg-background/10 space-y-1.5">
            <div>Open Assistant 2.0 — Crowdsourcing secure interaction dataset for public model training.</div>
            <LegalFooter />
          </footer>
        </main>
      )}

      <nav
        aria-label="Primary navigation"
        className="lg:hidden flex-shrink-0 grid auto-cols-fr grid-flow-col gap-1 border-t border-border/80 bg-background/95 px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] backdrop-blur-xl"
      >
        {navItems.map(({ tab, label, icon: Icon }) => (
          <Button
            key={tab}
            variant={activeTab === tab ? "secondary" : "ghost"}
            onClick={() => setActiveTab(tab)}
            className="h-12 min-w-0 flex-col gap-0.5 rounded-xl px-0.5 text-[9px] min-[400px]:text-[10px] font-semibold"
            aria-current={activeTab === tab ? "page" : undefined}
          >
            <Icon className="w-4 h-4" />
            <span>{label}</span>
          </Button>
        ))}
      </nav>
    </div>
  );
}

export default App;
