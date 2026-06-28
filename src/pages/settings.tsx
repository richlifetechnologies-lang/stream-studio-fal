import { useState } from "react";
  import { useLocation } from "wouter";
  import { AppLayout } from "../components/layout";
  import { Key, Trash2, Eye, EyeOff, Save, LogOut, CheckCircle2, ExternalLink } from "lucide-react";
  import { getApiKey, setApiKey, clearCredentials } from "../lib/credentials";
  import { useToast } from "../hooks/use-toast";

  const C = "hsl(187 100% 52%)";
  const BG = "hsl(222 47% 4%)";

  export default function SettingsPage() {
    const [, setLocation] = useLocation();
    const { toast } = useToast();

    const [newApiKey, setNewApiKey] = useState("");
    const [showApiKey, setShowApiKey] = useState(false);
    const [saved, setSaved] = useState(false);

    const currentApiKey = getApiKey() ?? "";
    const maskedApi = currentApiKey
      ? currentApiKey.slice(0, 6) + "â¢â¢â¢â¢â¢â¢â¢â¢" + currentApiKey.slice(-4)
      : "Not set";

    const handleUpdate = () => {
      const ak = newApiKey.trim();
      if (!ak) {
        toast({ title: "Nothing to update", description: "Enter your fal.ai API Key.", variant: "destructive" });
        return;
      }
      if (ak.length < 8) { toast({ title: "API Key too short", variant: "destructive" }); return; }
      setApiKey(ak);
      setNewApiKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      toast({ title: "API Key saved", description: "Your fal.ai key has been saved to this device." });
    };

    const handleClear = () => {
      if (!confirm("This will remove your fal.ai API Key from this device. Continue?")) return;
      clearCredentials();
      setLocation("/");
    };

    const inputStyle: React.CSSProperties = {
      width: "100%", padding: "10px 40px 10px 40px",
      background: BG, border: "1px solid hsl(222 40% 14%)",
      borderRadius: 8, color: "hsl(190 80% 96%)",
      fontSize: 14, fontFamily: "'Rajdhani', sans-serif", outline: "none",
    };

    const labelStyle: React.CSSProperties = {
      display: "block", fontSize: 10, fontWeight: 700,
      color: "hsl(222 25% 50%)", textTransform: "uppercase",
      letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace", marginBottom: 8,
    };

    return (
      <AppLayout>
        <div style={{ padding: 32, maxWidth: 620 }}>
          <div style={{ marginBottom: 28 }}>
            <h1 style={{ fontFamily: "'Orbitron', monospace", fontWeight: 700, fontSize: 20, letterSpacing: "0.06em", color: "hsl(190 80% 96%)", marginBottom: 4 }}>
              Account Settings
            </h1>
            <p style={{ color: "hsl(222 25% 50%)", fontSize: 14, fontFamily: "'Rajdhani', sans-serif" }}>
              Manage your fal.ai API Key stored on this device
            </p>
          </div>

          {/* Get API key link */}
          <div style={{ background: "hsl(187 100% 52% / 0.06)", border: "1px solid hsl(187 100% 52% / 0.2)", borderRadius: 12, padding: "12px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12 }}>
            <Key style={{ width: 15, height: 15, color: C, flexShrink: 0 }} />
            <p style={{ fontSize: 13, color: "hsl(190 80% 80%)", fontFamily: "'Rajdhani', sans-serif", flex: 1 }}>
              Don't have a fal.ai key yet?
            </p>
            <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noreferrer"
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, background: "hsl(187 100% 52% / 0.15)", border: "1px solid hsl(187 100% 52% / 0.35)", color: C, fontWeight: 700, fontSize: 12, fontFamily: "'Orbitron', monospace", textDecoration: "none", letterSpacing: "0.04em" }}>
              Get Key <ExternalLink style={{ width: 11, height: 11 }} />
            </a>
          </div>

          {/* Current key */}
          <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 20, marginBottom: 14 }}>
            <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace", marginBottom: 14 }}>
              Current Key
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "hsl(222 40% 8%)", borderRadius: 8, border: "1px solid hsl(222 40% 12%)" }}>
              <Key style={{ width: 14, height: 14, color: C, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 10, color: "hsl(222 25% 45%)", fontFamily: "'Orbitron', monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 2 }}>fal.ai API Key</p>
                <p style={{ fontSize: 13, color: "hsl(190 80% 90%)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{maskedApi}</p>
              </div>
            </div>
          </div>

          {/* Update key */}
          <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 20, marginBottom: 14 }}>
            <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron', monospace", marginBottom: 16 }}>
              Update API Key
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={labelStyle}>New fal.ai API Key</label>
                <div style={{ position: "relative" }}>
                  <Key style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "hsl(222 25% 40%)" }} />
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={newApiKey}
                    onChange={e => setNewApiKey(e.target.value)}
                    placeholder="Enter your fal.ai API Key"
                    style={inputStyle}
                    onKeyDown={e => { if (e.key === "Enter") handleUpdate(); }}
                    onFocus={e => { e.target.style.borderColor = "hsl(187 100% 52% / 0.5)"; e.target.style.boxShadow = "0 0 0 2px hsl(187 100% 52% / 0.1)"; }}
                    onBlur={e => { e.target.style.borderColor = "hsl(222 40% 14%)"; e.target.style.boxShadow = "none"; }}
                  />
                  <button type="button" onClick={() => setShowApiKey(v => !v)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "hsl(222 25% 45%)", padding: 4 }}>
                    {showApiKey ? <EyeOff style={{ width: 13, height: 13 }} /> : <Eye style={{ width: 13, height: 13 }} />}
                  </button>
                </div>
              </div>

              <button
                onClick={handleUpdate}
                disabled={!newApiKey.trim()}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "10px 18px", borderRadius: 8, width: "fit-content",
                  background: !newApiKey.trim() ? "hsl(222 40% 11%)" : saved ? "hsl(143 72% 35%)" : C,
                  border: "none",
                  cursor: !newApiKey.trim() ? "not-allowed" : "pointer",
                  color: !newApiKey.trim() ? "hsl(222 25% 35%)" : "hsl(222 47% 4%)",
                  fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani', sans-serif",
                  transition: "all 0.2s",
                }}
              >
                {saved ? <CheckCircle2 style={{ width: 14, height: 14 }} /> : <Save style={{ width: 14, height: 14 }} />}
                {saved ? "Saved!" : "Save Key"}
              </button>
            </div>
          </div>

          {/* Danger zone */}
          <div style={{ background: "hsl(0 60% 7%)", border: "1px solid hsl(0 85% 40% / 0.25)", borderRadius: 14, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <Trash2 style={{ width: 15, height: 15, color: "hsl(0 85% 65%)" }} />
              <p style={{ fontWeight: 700, fontSize: 14, color: "hsl(0 85% 75%)", fontFamily: "'Rajdhani', sans-serif" }}>Danger Zone</p>
            </div>
            <p style={{ fontSize: 13, color: "hsl(0 50% 60%)", marginBottom: 14, fontFamily: "'Rajdhani', sans-serif", lineHeight: 1.5 }}>
              Remove your fal.ai API Key from this device. You will need to re-enter it to start streaming.
            </p>
            <button
              onClick={handleClear}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "9px 16px", borderRadius: 8,
                background: "hsl(0 85% 40% / 0.2)", border: "1px solid hsl(0 85% 40% / 0.4)",
                cursor: "pointer", color: "hsl(0 85% 70%)",
                fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani', sans-serif", transition: "all 0.2s",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.35)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.2)"; }}
            >
              <LogOut style={{ width: 13, height: 13 }} />
              Remove Key &amp; Log Out
            </button>
          </div>
        </div>
      </AppLayout>
    );
  }
  