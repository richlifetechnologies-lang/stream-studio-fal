import { useState, useRef, useEffect } from "react";

export default function PopoutPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const tryGetStream = () => {
      try {
        const stream = (window.opener as any)?.__ssRemoteStream as MediaStream | undefined;
        if (stream && videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch { /* cross-origin guard */ }
    };

    tryGetStream();

    const handler = (e: MessageEvent) => {
      if (e.data?.type === "stream-studio-stream") {
        tryGetStream();
        setErrorMsg(null);
      }
      if (e.data === "stream-studio-clear" && videoRef.current) {
        videoRef.current.srcObject = null;
      }
      if (e.data?.type === "stream-studio-error") {
        setErrorMsg(e.data.message as string);
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleStop = () => {
    if (window.opener) window.opener.postMessage("stream-studio-stop", "*");
    window.close();
  };

  const handleReconnect = () => {
    setErrorMsg(null);
    if (window.opener) window.opener.postMessage("stream-studio-reconnect", "*");
  };

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#000", position: "relative", overflow: "hidden" }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }}
      />

      {/* Error overlay — shown when stream fails, so streamer isn't left with a silent black screen */}
      {errorMsg && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 14, background: "rgba(0,0,0,0.80)", padding: "24px", textAlign: "center",
        }}>
          <p style={{
            fontSize: 11, fontWeight: 700, letterSpacing: "0.1em",
            color: "hsl(0 85% 70%)", fontFamily: "monospace",
            textTransform: "uppercase", marginBottom: 2,
          }}>
            {errorMsg.toLowerCase().includes("balance") || errorMsg.toLowerCase().includes("zero")
              ? "Zero Balance"
              : "Stream Stopped"}
          </p>
          <p style={{
            fontSize: 13, color: "rgba(255,255,255,0.65)",
            fontFamily: "monospace", lineHeight: 1.6,
            maxWidth: 340,
          }}>
            {errorMsg}
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button
              onClick={handleReconnect}
              style={{
                padding: "6px 14px", borderRadius: 6,
                background: "hsl(187 100% 52% / 0.9)", color: "hsl(222 47% 4%)",
                border: "none", fontWeight: 700, fontSize: 11,
                fontFamily: "monospace", letterSpacing: 1, cursor: "pointer",
              }}
            >
              RECONNECT
            </button>
            <button
              onClick={handleStop}
              style={{
                padding: "6px 14px", borderRadius: 6,
                background: "rgba(220,38,38,0.85)", color: "#fff",
                border: "none", fontWeight: 700, fontSize: 11,
                fontFamily: "monospace", letterSpacing: 1, cursor: "pointer",
              }}
            >
              CLOSE
            </button>
          </div>
        </div>
      )}

      {/* Normal hover controls — only shown when there is no error */}
      {!errorMsg && (
        <div
          style={{
            position: "absolute", bottom: 12, right: 12,
            display: "flex", gap: 8,
            opacity: 0, transition: "opacity 0.2s",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = "0"; }}
        >
          <button
            onClick={handleReconnect}
            style={{
              padding: "6px 14px", borderRadius: 6,
              background: "hsl(187 100% 52% / 0.9)", color: "hsl(222 47% 4%)",
              border: "none", fontWeight: 700, fontSize: 11,
              fontFamily: "monospace", letterSpacing: 1, cursor: "pointer",
            }}
          >
            RECONNECT
          </button>
          <button
            onClick={handleStop}
            style={{
              padding: "6px 14px", borderRadius: 6,
              background: "rgba(220,38,38,0.85)", color: "#fff",
              border: "none", fontWeight: 700, fontSize: 11,
              fontFamily: "monospace", letterSpacing: 1, cursor: "pointer",
            }}
          >
            STOP
          </button>
        </div>
      )}
    </div>
  );
}
