import { useState, useRef, useEffect, useCallback } from "react";
  import { useLocation } from "wouter";
  import { AppLayout } from "../components/layout";
  import { useToast } from "../hooks/use-toast";
  import { getApiKey, hasCredentials } from "../lib/credentials";
  import { sessionStart, sessionTick, sessionEnd } from "../lib/session-store";
  import {
    Zap, Square, Play, Camera, Monitor, Maximize2,
    RefreshCw, ChevronDown, Image, Loader2, X,
    Settings, Mic, Wifi, WifiOff,
  } from "lucide-react";

  import { fal } from "@fal-ai/client";

  const STYLES = [
    { id: "hyper-real",  label: "HYPER-REAL",  color: "#00d2d3", prompt: "photorealistic human, ultra-high-definition, natural skin texture, cinematic lighting, professional photography" },
    { id: "anime",       label: "ANIME",        color: "#a29bfe", prompt: "anime art style, cel shading, vibrant colors, clean lines, studio animation quality" },
    { id: "cinematic",   label: "CINEMATIC",    color: "#fdcb6e", prompt: "cinematic film look, dramatic lighting, movie quality, depth of field, anamorphic lens flare" },
    { id: "cyberpunk",   label: "CYBERPUNK",    color: "#fd79a8", prompt: "cyberpunk style, neon lights, futuristic city, chrome and neon, night scene, blade runner aesthetic" },
    { id: "fantasy",     label: "FANTASY",      color: "#55efc4", prompt: "fantasy art style, ethereal glow, mystical atmosphere, magical lighting, painterly quality" },
    { id: "horror",      label: "HORROR",       color: "#e17055", prompt: "horror film style, dark and sinister, dramatic shadows, unsettling atmosphere, desaturated with deep red accents" },
    { id: "neon-noir",   label: "NEON NOIR",    color: "#74b9ff", prompt: "neon noir style, rain-soaked streets, neon reflections, deep shadows, film noir meets cyberpunk" },
    { id: "watercolor",  label: "WATERCOLOR",   color: "#81ecec", prompt: "watercolor painting, soft brushstrokes, artistic, fluid colors, traditional art technique" },
    { id: "sketch",      label: "SKETCH",       color: "#dfe6e9", prompt: "pencil sketch style, hand-drawn, graphite lines, artistic rendering, detailed crosshatching" },
  ] as const;
  type StyleId = typeof STYLES[number]["id"];

  function formatTime(s: number) {
    return `${Math.floor(s / 60).toString().padStart(2, "0")}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
  }

  const C = "hsl(187 100% 52%)";

  const WINDOW_MS  = 60;
  const BUF_SECS   = 6;
  const BUF_LEN    = Math.round((BUF_SECS * 1000) / WINDOW_MS);
  const MAX_DELAY  = 4.0;
  const MIN_DELAY  = 0.2;

  class AutoSyncEngine {
    private audioCtx:   AudioContext | null = null;
    private analyser:   AnalyserNode  | null = null;
    private delayNode:  DelayNode     | null = null;
    private gainNode:   GainNode      | null = null;
    private dest:       MediaStreamAudioDestinationNode | null = null;
    private freqData:   Uint8Array    = new Uint8Array(0);
    private audioSig:   number[]      = [];
    private videoSig:   number[]      = [];
    private offCanvas:  OffscreenCanvas | null = null;
    private offCtx:     OffscreenCanvasRenderingContext2D | null = null;
    private prevPixels: Uint8ClampedArray | null = null;
    private timer:      ReturnType<typeof setInterval> | null = null;
    private videoEl:    HTMLVideoElement | null = null;

    detectedDelay = 1.2;
    vuLevel = 0;
    onUpdate?: (delay: number, vu: number) => void;

    async start(videoEl: HTMLVideoElement): Promise<MediaStreamAudioDestinationNode | null> {
      this.videoEl = videoEl;
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(mic);
        const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
        this.freqData = new Uint8Array(analyser.frequencyBinCount);
        const delay = ctx.createDelay(MAX_DELAY + 0.5);
        delay.delayTime.value = this.detectedDelay;
        const gain = ctx.createGain(); gain.gain.value = 1.0;
        const dest = ctx.createMediaStreamDestination();
        src.connect(analyser);
        analyser.connect(delay);
        delay.connect(gain);
        gain.connect(dest);

        this.audioCtx = ctx; this.analyser = analyser;
        this.delayNode = delay; this.gainNode = gain; this.dest = dest;

        this.offCanvas = new OffscreenCanvas(80, 45);
        this.offCtx = this.offCanvas.getContext("2d")!;

        this.timer = setInterval(() => this._tick(), WINDOW_MS);
        return dest;
      } catch {
        return null;
      }
    }

    private _tick() {
      if (!this.analyser || !this.videoEl) return;

      this.analyser.getByteFrequencyData(this.freqData);
      const rms = Math.sqrt(this.freqData.reduce((s, v) => s + v * v, 0) / this.freqData.length) / 128;
      this.vuLevel = Math.min(100, rms * 100);

      let vDelta = 0;
      if (this.offCtx && !this.videoEl.paused && this.videoEl.readyState >= 2) {
        try {
          this.offCtx.drawImage(this.videoEl, 0, 0, 80, 45);
          const frame = this.offCtx.getImageData(0, 0, 80, 45);
          if (this.prevPixels) {
            let sum = 0;
            for (let i = 0; i < frame.data.length; i += 4) {
              sum += Math.abs(frame.data[i] - this.prevPixels[i])
                   + Math.abs(frame.data[i+1] - this.prevPixels[i+1])
                   + Math.abs(frame.data[i+2] - this.prevPixels[i+2]);
            }
            vDelta = sum / (frame.data.length * 0.75 * 255);
          }
          this.prevPixels = new Uint8ClampedArray(frame.data);
        } catch { /* cross-origin or not ready */ }
      }

      this.audioSig.push(rms);
      this.videoSig.push(vDelta);
      if (this.audioSig.length > BUF_LEN) this.audioSig.shift();
      if (this.videoSig.length > BUF_LEN) this.videoSig.shift();

      if (this.audioSig.length === BUF_LEN && this.audioSig.length % 50 === 0) {
        const maxLagSamples = Math.round((MAX_DELAY * 1000) / WINDOW_MS);
        let bestLag = 0, bestCorr = -Infinity;

        for (let lag = 1; lag <= maxLagSamples; lag++) {
          let corr = 0;
          const n = BUF_LEN - lag;
          for (let i = 0; i < n; i++) {
            corr += this.audioSig[i] * this.videoSig[i + lag];
          }
          if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
        }

        const newDelay = Math.max(MIN_DELAY, Math.min(MAX_DELAY, bestLag * WINDOW_MS / 1000));
        this.detectedDelay = 0.8 * this.detectedDelay + 0.2 * newDelay;
        if (this.delayNode) this.delayNode.delayTime.value = this.detectedDelay;
      }

      this.onUpdate?.(this.detectedDelay, this.vuLevel);
    }

    stop() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
      this.dest = null; this.delayNode = null; this.gainNode = null;
      this.analyser = null; this.audioSig = []; this.videoSig = [];
      this.prevPixels = null;
    }

    getDestStream(): MediaStream | null {
      return this.dest?.stream ?? null;
    }
  }

  function getBaseUrl(): string {
    return window.location.href.split("#")[0];
  }

  function notifyPopup(w: Window | null) {
    if (w && !w.closed) {
      try { w.postMessage({ type: "stream-studio-stream" }, "*"); } catch { /* ignore */ }
    }
  }

  export default function StreamPage() {
    const [, setLocation] = useLocation();
    const { toast } = useToast();

    const [connectionStatus, setConnectionStatus] = useState<"idle"|"connecting"|"connected"|"error">("idle");
    const [isStreaming, setIsStreaming]   = useState(false);
    const [isStarting, setIsStarting]    = useState(false);
    const [connectionStep, setConnectionStep] = useState<"auth"|"engine"|null>(null);
    const [elapsedSecs, setElapsedSecs]  = useState(0);

    const [cameras, setCameras]               = useState<MediaDeviceInfo[]>([]);
    const [selectedCameraId, setSelectedCameraId] = useState("");
    const [cameraReady, setCameraReady]       = useState(false);

    const [selectedStyle, setSelectedStyle]   = useState<StyleId>("hyper-real");
    const [customPrompt, setCustomPrompt]     = useState("");

    const [syncDelay, setSyncDelay]   = useState(1.2);
    const [vuLevel, setVuLevel]       = useState(0);
    const [audioActive, setAudioActive] = useState(false);

    const [refImageB64, setRefImageB64]         = useState<string|null>(null);
    const [refImagePreview, setRefImagePreview] = useState<string|null>(null);
    const [streamError, setStreamError]   = useState<string|null>(null);

    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isPopoutOpen, setIsPopoutOpen] = useState(false);
    const [isObsModeActive, setIsObsModeActive] = useState(false);
    const [obsInstructions, setObsInstructions] = useState(false);

    const localVideoRef   = useRef<HTMLVideoElement>(null);
    const remoteVideoRef  = useRef<HTMLVideoElement>(null);
    const localStreamRef  = useRef<MediaStream|null>(null);
    const falConnRef      = useRef<ReturnType<typeof fal.realtime.connect> | null>(null);
    const pcRef           = useRef<RTCPeerConnection|null>(null);
    const syncEngineRef   = useRef<AutoSyncEngine|null>(null);
    const timerRef        = useRef<ReturnType<typeof setInterval>|null>(null);
    const popoutRef       = useRef<Window|null>(null);
    const obsWindowRef    = useRef<Window|null>(null);
    const remoteStreamRef = useRef<MediaStream|null>(null);
    const isStartingRef   = useRef(false);

    const credsMissing = !hasCredentials();

    // âââ Camera ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    const enumerateCameras = useCallback(async () => {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const vids = devs.filter(d => d.kind === "videoinput");
        setCameras(vids);
        if (vids.length && !selectedCameraId) setSelectedCameraId(vids[0].deviceId);
      } catch { /* ignore */ }
    }, [selectedCameraId]);

    useEffect(() => { enumerateCameras(); }, []);

    const startCamera = useCallback(async (deviceId?: string) => {
      const id = deviceId ?? selectedCameraId;
      try {
        localStreamRef.current?.getTracks().forEach(t => t.stop());
        const stream = await navigator.mediaDevices.getUserMedia({
          video: id
            ? { deviceId: { exact: id }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
            : { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        setCameraReady(true);
        enumerateCameras();
      } catch {
        toast({ title: "Camera Error", description: "Could not access your camera. Check browser permissions.", variant: "destructive" });
      }
    }, [selectedCameraId, enumerateCameras, toast]);

    const handleCameraSwitch = useCallback(async (id: string) => {
      setSelectedCameraId(id);
      if (cameraReady) await startCamera(id);
    }, [cameraReady, startCamera]);

    // âââ Teardown âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    const teardownStream = useCallback(async () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      isStartingRef.current = false;

      try { falConnRef.current?.close(); } catch { /* ignore */ }
      falConnRef.current = null;

      try { pcRef.current?.close(); } catch { /* ignore */ }
      pcRef.current = null;

      syncEngineRef.current?.stop();
      syncEngineRef.current = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      remoteStreamRef.current = null;

      window.__ssRemoteStream = null;

      if (popoutRef.current && !popoutRef.current.closed) {
        try { popoutRef.current.postMessage("stream-studio-clear", "*"); } catch { /* ignore */ }
      }
      if (obsWindowRef.current && !obsWindowRef.current.closed) {
        try { obsWindowRef.current.postMessage("stream-studio-clear", "*"); } catch { /* ignore */ }
      }

      sessionEnd();
      setIsStreaming(false); setConnectionStatus("idle");
      setConnectionStep(null); setElapsedSecs(0);
      setAudioActive(false); setSyncDelay(1.2); setVuLevel(0);
      setStreamError(null);
    }, []);

    // âââ Start stream âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    const handleStartStream = useCallback(async () => {
      if (isStartingRef.current || isStreaming) return;
      if (credsMissing) { setLocation("/settings"); return; }
      if (!cameraReady || !localStreamRef.current) {
        toast({ title: "Camera not ready", description: "Enable your camera first.", variant: "destructive" }); return;
      }

      const falApiKey = getApiKey()!;
      isStartingRef.current = true; setIsStarting(true);
      setStreamError(null);
      setConnectionStep("auth"); setConnectionStatus("connecting");

      try {
        setConnectionStep("engine");
        const style = STYLES.find(s => s.id === selectedStyle)!;
        const prompt = customPrompt.trim() || style.prompt;

        fal.config({ credentials: falApiKey });

        // Pre-flight: catch balance/key errors before WebRTC handshake
        try {
          const _pf = await fetch("https://fal.run/decart/lucy2-vton/realtime", {
            method: "POST",
            headers: { "Authorization": `Key ${falApiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "__preflight__" }),
            signal: AbortSignal.timeout(8000),
          });
          if (_pf.status === 401 || _pf.status === 403) {
            const _pfBody = await _pf.json().catch(() => ({}) as Record<string,unknown>) as Record<string,unknown>;
            const _pfDetail = String(_pfBody.detail ?? _pfBody.error ?? "");
            if (_pfDetail.toLowerCase().includes("balance") || _pfDetail.toLowerCase().includes("exhausted") || _pfDetail.toLowerCase().includes("locked")) {
              throw new Error("Your fal.ai account has no credits — top up at fal.ai/dashboard/billing, then try again.");
            }
            throw new Error("Invalid fal.ai API key. Open Settings and paste your key from fal.ai/dashboard/keys.");
          }
        } catch (_pfErr) {
          if (_pfErr instanceof Error && (_pfErr.message.includes("fal.ai") || _pfErr.message.includes("credits") || _pfErr.message.includes("API key"))) throw _pfErr;
          // Network/CORS error — proceed; server will surface auth issues
        }

        const engine = new AutoSyncEngine();
        engine.onUpdate = (delay, vu) => { setSyncDelay(delay); setVuLevel(vu); };
        const audioStream = await engine.start(remoteVideoRef.current!);
        syncEngineRef.current = engine;

        let combined = localStreamRef.current!;
        if (audioStream) {
          const track = audioStream.stream.getAudioTracks()[0];
          if (track) combined = new MediaStream([...localStreamRef.current!.getVideoTracks(), track]);
          setAudioActive(true);
        }

        // Connect to fal.ai Lucy 2.1 via realtime WebSocket
        // The server will respond with WebRTC signaling messages (iceservers, answer, icecandidate)
        const conn = fal.realtime.connect("decart/lucy2-vton/realtime", {
          connectionKey: `ss-${Date.now()}`,
          throttleInterval: 0,
          onResult: async (result: Record<string, unknown>) => {
            const type = result.type as string | undefined;

            switch (type) {
              case "iceservers":
              case "iceServers": {
                const rawServers = (
                  (result.iceservers ?? result.iceServers ?? result.ice_servers ?? []) as Array<{
                    urls: string | string[]; username?: string; credential?: string;
                  }>
                ).map(s => ({ urls: s.urls, username: s.username, credential: s.credential }));

                const pc = new RTCPeerConnection({ iceServers: rawServers });
                pcRef.current = pc;

                combined.getTracks().forEach(t => pc.addTrack(t, combined));

                pc.ontrack = (e) => {
                  const remote = e.streams[0] ?? new MediaStream([e.track]);
                  remoteStreamRef.current = remote;
                  if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remote;
                  window.__ssRemoteStream = remote;
                  notifyPopup(popoutRef.current);
                  notifyPopup(obsWindowRef.current);
                  setConnectionStatus("connected");
                  setIsStreaming(true);
                  sessionStart();
                  const t0 = Date.now();
                  timerRef.current = setInterval(() => {
                    const s = Math.floor((Date.now() - t0) / 1000);
                    setElapsedSecs(s);
                    sessionTick(s);
                  }, 1000);
                };

                pc.onconnectionstatechange = () => {
                  if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
                    teardownStream();
                    toast({ title: "Stream disconnected", description: "Connection lost. Try again.", variant: "destructive" });
                  }
                };

                pc.onicecandidate = (e) => {
                  if (e.candidate) {
                    conn.send({
                      type: "icecandidate",
                      candidate: {
                        candidate: e.candidate.candidate,
                        sdpMid: e.candidate.sdpMid,
                        sdpMLineIndex: e.candidate.sdpMLineIndex,
                      },
                    });
                  }
                };

                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                conn.send({ type: "offer", sdp: offer.sdp });
                break;
              }

              case "answer":
                await pcRef.current?.setRemoteDescription({
                  type: "answer",
                  sdp: result.sdp as string,
                });
                break;

              case "icecandidate":
                if (result.candidate) {
                  await pcRef.current?.addIceCandidate(
                    new RTCIceCandidate(result.candidate as RTCIceCandidateInit)
                  );
                }
                break;

              case "ice-restart": {
                const tc = result.turn_config as { server_url: string; username: string; credential: string } | undefined;
                if (tc && pcRef.current) {
                  pcRef.current.setConfiguration({
                    iceServers: [
                      { urls: "stun:stun.l.google.com:19302" },
                      { urls: tc.server_url, username: tc.username, credential: tc.credential },
                    ],
                  });
                  const restartOffer = await pcRef.current.createOffer({ iceRestart: true });
                  await pcRef.current.setLocalDescription(restartOffer);
                  conn.send({ type: "offer", sdp: restartOffer.sdp });
                }
                break;
              }

              case "generation_started":
                setConnectionStatus("connected");
                break;

              case "prompt_ack":
                if (!(result.success as boolean)) {
                  toast({ title: "Prompt rejected", description: String(result.error ?? "Try a different style prompt."), variant: "destructive" });
                }
                break;

              case "set_image_ack":
                break;

              case "error":
                teardownStream();
                toast({ title: "Stream Error", description: String(result.error ?? "Server error occurred."), variant: "destructive" });
                break;

              default:
                break;
            }
          },
          onError: (err: unknown) => {
            const msg = err instanceof Error ? err.message : "Connection error. Check your fal.ai API key.";
            teardownStream();
            toast({ title: "Stream Failed", description: msg, variant: "destructive" });
          },
        });

        falConnRef.current = conn;

        // Send initial prompt to trigger the WebRTC session on the server
        const payload: Record<string, unknown> = { prompt };
        if (refImageB64) payload.reference_image_url = `data:image/jpeg;base64,${refImageB64}`;
        conn.send(payload);

      } catch (err) {
        const _errMsg = err instanceof Error ? err.message : "Check your fal.ai API Key in Settings.";
        teardownStream();
        setStreamError(_errMsg);
        toast({ title: "Stream Failed", description: _errMsg, variant: "destructive" });
      } finally {
        isStartingRef.current = false; setIsStarting(false);
      }
    }, [isStreaming, credsMissing, cameraReady, selectedStyle, customPrompt, refImageB64, teardownStream, toast, setLocation]);

    const handleStopStream = useCallback(() => teardownStream(), [teardownStream]);

    // âââ Reference image âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    const handleRefImage = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]; if (!file) return;
      const r = new FileReader();
      r.onload = ev => {
        const data = ev.target?.result as string;
        setRefImagePreview(data);
        const b64 = data.split(",")[1] ?? data;
        setRefImageB64(b64);
        if (falConnRef.current) {
          falConnRef.current.send({
            reference_image_url: `data:image/jpeg;base64,${b64}`,
          });
        }
      };
      r.readAsDataURL(file); e.target.value = "";
    }, []);

    // âââ Regular popout (controls visible on hover) ââââââââââââââââââââââââââââ
    const openPopout = useCallback(() => {
      if (popoutRef.current && !popoutRef.current.closed) { popoutRef.current.focus(); return; }
      const base = getBaseUrl();
      const w = window.open(base + "#/popout", "ss-popout", "width=1280,height=720,menubar=no,toolbar=no,location=no");
      if (!w) return;
      popoutRef.current = w;
      setIsPopoutOpen(true);
      w.addEventListener("load", () => notifyPopup(w));
      const chk = setInterval(() => {
        if (w.closed) { clearInterval(chk); setIsPopoutOpen(false); popoutRef.current = null; }
      }, 1000);
    }, []);

    // âââ OBS clean output window âââââââââââââââââââââââââââââââââââââââââââââââ
    const openObsWindow = useCallback(() => {
      if (obsWindowRef.current && !obsWindowRef.current.closed) { obsWindowRef.current.focus(); return; }
      const base = getBaseUrl();
      const w = window.open(base + "#/obsout", "ss-obsout", "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no");
      if (!w) return;
      obsWindowRef.current = w;
      setIsObsModeActive(true);
      setObsInstructions(true);
      w.addEventListener("load", () => notifyPopup(w));
      const chk = setInterval(() => {
        if (w.closed) { clearInterval(chk); setIsObsModeActive(false); setObsInstructions(false); obsWindowRef.current = null; }
      }, 1000);
    }, []);

    const closeObsWindow = useCallback(() => {
      if (obsWindowRef.current && !obsWindowRef.current.closed) obsWindowRef.current.close();
      obsWindowRef.current = null;
      setIsObsModeActive(false);
      setObsInstructions(false);
    }, []);

    const closePopout = useCallback(() => {
      if (popoutRef.current && !popoutRef.current.closed) popoutRef.current.close();
      popoutRef.current = null;
      setIsPopoutOpen(false);
    }, []);

    const closeAllPopups = useCallback(() => {
      closePopout();
      closeObsWindow();
    }, [closePopout, closeObsWindow]);

    // âââ Message listener (from popout windows) ââââââââââââââââââââââââââââââââ
    useEffect(() => {
      const h = (e: MessageEvent) => {
        if (e.data === "stream-studio-stop") teardownStream();
        else if (e.data === "stream-studio-reconnect" && cameraReady) {
          teardownStream();
          setTimeout(() => handleStartStream(), 300);
        }
      };
      window.addEventListener("message", h);
      return () => window.removeEventListener("message", h);
    }, [teardownStream, cameraReady, handleStartStream]);

    // âââ Keyboard shortcuts ââââââââââââââââââââââââââââââââââââââââââââââââââââ
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          if (isFullscreen) {
            teardownStream();
            setIsFullscreen(false);
            return;
          }
          closeAllPopups();
          if (isStreaming) teardownStream();
          return;
        }
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (e.key === "f" || e.key === "F") {
          e.preventDefault();
          setIsFullscreen(v => !v);
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [isStreaming, isFullscreen, teardownStream, closeAllPopups]);

    const style = STYLES.find(s => s.id === selectedStyle)!;
  
return (
    <AppLayout>
      {streamError && (
        <div style={{ background: "#c0392b", color: "#fff", padding: "12px 20px", display: "flex", alignItems: "center", gap: 12, fontSize: 13, fontFamily: "monospace" }}>
          <span>⚠</span>
          <span style={{ flex: 1 }}>{streamError}</span>
          <button onClick={() => setStreamError(null)} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>
      )}
      {/* Ã¢ÂÂÃ¢ÂÂ Missing credentials banner Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ */}
      {credsMissing && (
        <div style={{ margin: "16px 32px 0", padding: "12px 18px", borderRadius: 10, background: "hsl(40 100% 52% / 0.1)", border: "1px solid hsl(40 100% 52% / 0.35)", display: "flex", alignItems: "center", gap: 12 }}>
          <Settings style={{ width: 16, height: 16, color: "hsl(40 100% 62%)", flexShrink: 0 }} />
          <p style={{ fontSize: 13, color: "hsl(40 100% 75%)", fontFamily: "'Rajdhani',sans-serif", flex: 1 }}>
            <strong>API Key not set.</strong> Go to Settings to add it before streaming.
          </p>
          <button onClick={() => setLocation("/settings")} style={{ padding: "6px 14px", borderRadius: 8, background: "hsl(40 100% 52% / 0.25)", border: "1px solid hsl(40 100% 52% / 0.5)", color: "hsl(40 100% 80%)", fontWeight: 700, fontSize: 12, fontFamily: "'Orbitron',monospace", cursor: "pointer", letterSpacing: "0.04em" }}>
            Open Settings
          </button>
        </div>
      )}

      {/* Ã¢ÂÂÃ¢ÂÂ Starting overlay Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ */}
      {isStarting && (
        <div style={{ position: "fixed", inset: 0, zIndex: 55, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "absolute", inset: 0, backdropFilter: "blur(8px)", background: "hsl(222 47% 4% / 0.88)" }} />
          <div style={{ position: "relative", zIndex: 10, display: "flex", flexDirection: "column", alignItems: "center", gap: 20, maxWidth: 360, width: "100%", margin: "0 16px", textAlign: "center", padding: 36, borderRadius: 20, background: "hsl(222 44% 6%)", border: "1px solid hsl(187 100% 52% / 0.22)", boxShadow: "0 0 60px hsl(187 100% 52% / 0.14)" }}>
            <div style={{ width: 72, height: 72, borderRadius: "50%", background: "hsl(187 100% 52% / 0.08)", border: "2px solid hsl(187 100% 52% / 0.3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Loader2 style={{ width: 32, height: 32, color: C, animation: "spin 1s linear infinite" }} />
            </div>
            <div>
              <h3 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 16, letterSpacing: "0.06em", color: "hsl(190 80% 96%)", marginBottom: 8 }}>Starting StreamÃ¢ÂÂ¦</h3>
              <p style={{ fontSize: 13, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif" }}>
                {connectionStep === "engine" ? "2/2 ÃÂ· Connecting to AI engine + auto-syncing audioÃ¢ÂÂ¦" : "1/2 ÃÂ· Validating credentialsÃ¢ÂÂ¦"}
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, width: "100%", padding: "0 8px" }}>
              {["auth", "engine"].map((step, i) => {
                const idx = ["auth", "engine"].indexOf(connectionStep ?? "auth");
                return <div key={step} style={{ flex: 1, height: 4, borderRadius: 2, transition: "all 0.5s", background: i < idx ? C : i === idx ? "hsl(187 100% 52% / 0.45)" : "hsl(222 40% 14%)" }} />;
              })}
            </div>
            <button onClick={() => teardownStream()}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 20px", borderRadius: 8, width: "100%", justifyContent: "center", background: "transparent", border: "1px solid hsl(187 100% 52% / 0.25)", color: "hsl(187 100% 52% / 0.8)", fontWeight: 700, fontSize: 13, fontFamily: "'Rajdhani',sans-serif", cursor: "pointer" }}>
              <X style={{ width: 14, height: 14 }} /> Cancel
            </button>
          </div>
        </div>
      )}

      {/* Ã¢ÂÂÃ¢ÂÂ In-app fullscreen overlay (F key or Maximize button) Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
          Shows only the AI output video, no UI chrome.
          Close button stops the stream and exits fullscreen.           Ã¢ÂÂÃ¢ÂÂ */}
      {isFullscreen && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9000,
          background: "#000",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <video
            autoPlay
            playsInline
            ref={(el) => {
              if (el && remoteStreamRef.current) el.srcObject = remoteStreamRef.current;
            }}
            style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)", display: "block" }}
          />
          {/* Close button Ã¢ÂÂ stops the stream */}
          <button
            onClick={() => { teardownStream(); setIsFullscreen(false); }}
            title="Stop stream & exit fullscreen (Esc)"
            style={{
              position: "absolute", top: 16, left: 16, zIndex: 10,
              width: 36, height: 36, borderRadius: "50%",
              background: "rgba(220,38,38,0.85)", border: "1px solid rgba(255,100,100,0.4)",
              color: "#fff", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
            }}
          >
            <X style={{ width: 16, height: 16 }} />
          </button>
          {/* Elapsed timer */}
          {isStreaming && (
            <div style={{
              position: "absolute", top: 16, right: 16,
              padding: "4px 12px", borderRadius: 20,
              background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.15)",
              color: C, fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 13,
              letterSpacing: "0.06em",
            }}>
              {formatTime(elapsedSecs)}
            </div>
          )}
        </div>
      )}

      <div style={{ padding: "24px 32px", maxWidth: 1400, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22, flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 20, letterSpacing: "0.06em", color: "hsl(190 80% 96%)", marginBottom: 2 }}>Live Stream</h1>
            <p style={{ fontSize: 13, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif" }}>Real-time AI video transformation</p>
          </div>
          {isStreaming && connectionStatus === "connected" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderRadius: 10, background: "hsl(0 85% 55% / 0.1)", border: "1px solid hsl(0 85% 55% / 0.2)" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "hsl(0 85% 65%)", animation: "pulse 2s ease-in-out infinite" }} />
              <span style={{ fontSize: 11, color: "hsl(0 85% 70%)", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700 }}>LIVE ÃÂ· {formatTime(elapsedSecs)}</span>
            </div>
          )}
        </div>

        {/* Main grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 316px", gap: 20 }}>

          {/* Ã¢ÂÂÃ¢ÂÂ Left column Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* AI Output video panel */}
            <div style={{
              position: "relative", width: "100%", aspectRatio: "16/9",
              borderRadius: 14, overflow: "hidden", background: "#000",
              boxShadow: connectionStatus === "connected"
                ? `0 0 40px hsl(187 100% 52% / 0.25), 0 0 0 1px hsl(187 100% 52% / 0.15)`
                : "0 0 0 1px hsl(222 40% 14%)",
            }}>
              <video ref={remoteVideoRef} autoPlay playsInline style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", transform: "scaleX(-1)" }} />

              {connectionStatus === "idle" && (
                <div style={{ position: "absolute", inset: 0, zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, background: "radial-gradient(ellipse at center, hsl(222 44% 8%) 0%, hsl(222 47% 4%) 100%)" }}>
                  <div style={{ width: 72, height: 72, borderRadius: "50%", background: "hsl(187 100% 52% / 0.08)", border: "2px solid hsl(187 100% 52% / 0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Zap style={{ width: 32, height: 32, color: C }} />
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <p style={{ fontFamily: "'Orbitron',monospace", fontSize: 14, fontWeight: 700, color: "hsl(190 80% 96%)", marginBottom: 6 }}>AI Output</p>
                    <p style={{ fontSize: 13, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>Enable camera and click Stream Now</p>
                  </div>
                </div>
              )}

              {/* Top-right action buttons */}
              <div style={{ position: "absolute", top: 10, right: 10, zIndex: 20, display: "flex", gap: 6 }}>
                {/* OBS Ã¢ÂÂ opens a completely clean window for window-capture in OBS */}
                <div style={{ position: "relative" }}>
                  <button
                    onClick={isObsModeActive ? closeObsWindow : openObsWindow}
                    title={isObsModeActive ? "Close OBS window" : "Open clean OBS output window"}
                    style={{
                      display: "flex", alignItems: "center", gap: 5,
                      height: 30, padding: "0 10px", borderRadius: 20,
                      background: isObsModeActive ? "rgba(0,210,211,0.9)" : "rgba(0,0,0,0.6)",
                      color: isObsModeActive ? "hsl(222 47% 4%)" : "#fff",
                      border: isObsModeActive ? "1px solid rgba(0,210,211,0.6)" : "1px solid rgba(255,255,255,0.2)",
                      fontSize: 10, fontWeight: 700, fontFamily: "monospace", letterSpacing: 1,
                      cursor: "pointer",
                      boxShadow: isObsModeActive ? "0 0 12px rgba(0,210,211,0.4)" : "none",
                    }}
                  >
                    <Monitor style={{ width: 11, height: 11 }} /> OBS
                  </button>
                  {obsInstructions && (
                    <div style={{ position: "absolute", top: 36, right: 0, width: 240, background: "hsl(222 44% 7%)", border: "1px solid rgba(0,210,211,0.3)", borderRadius: 12, padding: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.6)", zIndex: 30 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: C, fontFamily: "monospace", letterSpacing: 1 }}>Ã¢ÂÂ OBS WINDOW OPEN</span>
                        <button onClick={() => setObsInstructions(false)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", fontSize: 16 }}>ÃÂ</button>
                      </div>
                      <p style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 }}>
                        Clean output window is open Ã¢ÂÂ no controls or UI. In OBS Ã¢ÂÂ Sources Ã¢ÂÂ + Ã¢ÂÂ Window Capture Ã¢ÂÂ select "Stream Studio OBS".
                      </p>
                    </div>
                  )}
                </div>

                {/* Regular popout (controls on hover) */}
                <button
                  onClick={isPopoutOpen ? closePopout : openPopout}
                  title={isPopoutOpen ? "Close popout" : "Open popout window"}
                  style={{
                    width: 30, height: 30, borderRadius: "50%",
                    background: isPopoutOpen ? "rgba(0,210,211,0.85)" : "rgba(0,0,0,0.6)",
                    border: isPopoutOpen ? "1px solid rgba(0,210,211,0.5)" : "1px solid rgba(255,255,255,0.2)",
                    color: "#fff", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Monitor style={{ width: 13, height: 13 }} />
                </button>

                {/* Fullscreen (in-app overlay) */}
                <button
                  onClick={() => setIsFullscreen(v => !v)}
                  title="Fullscreen AI output (F)"
                  style={{
                    width: 30, height: 30, borderRadius: "50%",
                    background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.2)",
                    color: "#fff", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Maximize2 style={{ width: 13, height: 13 }} />
                </button>
              </div>

              {/* PiP local camera */}
              <div style={{ position: "absolute", bottom: 10, left: 10, zIndex: 10, width: "22%", aspectRatio: "16/9", borderRadius: 10, overflow: "hidden", border: "1px solid rgba(255,255,255,0.2)", background: "#000", boxShadow: "0 4px 20px rgba(0,0,0,0.6)" }}>
                <video ref={localVideoRef} autoPlay muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
                {!cameraReady && (
                  <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, background: "rgba(0,0,0,0.85)" }}>
                    <Camera style={{ width: 18, height: 18, color: "hsl(222 25% 50%)" }} />
                    <button onClick={() => startCamera()} style={{ fontSize: 10, color: C, fontWeight: 700, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Enable Camera</button>
                  </div>
                )}
                <div style={{ position: "absolute", bottom: 3, left: 4, right: 4, background: "rgba(0,0,0,0.7)", borderRadius: 4, fontSize: 8, color: "rgba(255,255,255,0.6)", fontFamily: "monospace", padding: "1px 4px", letterSpacing: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  INPUT{cameras.length && selectedCameraId ? ` ÃÂ· ${cameras.find(c => c.deviceId === selectedCameraId)?.label || "Camera"}` : ""}
                </div>
              </div>
            </div>

            {/* Camera selector */}
            <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: "hsl(187 100% 52% / 0.1)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Camera style={{ width: 15, height: 15, color: C }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em" }}>Camera Source</p>
                  <span style={{ fontSize: 10, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>{cameras.length} detected</span>
                </div>
                {cameras.length === 0 ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <p style={{ fontSize: 12, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", flex: 1 }}>No cameras found.</p>
                    <button onClick={enumerateCameras} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: C, background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}><RefreshCw style={{ width: 11, height: 11 }} /> Scan</button>
                  </div>
                ) : (
                  <div style={{ position: "relative" }}>
                    <select value={selectedCameraId} onChange={e => handleCameraSwitch(e.target.value)} disabled={isStreaming} style={{ width: "100%", appearance: "none", padding: "8px 32px 8px 12px", background: "hsl(222 47% 4%)", border: "1px solid hsl(222 40% 14%)", borderRadius: 8, color: "hsl(190 80% 96%)", fontSize: 13, fontFamily: "'Rajdhani',sans-serif", cursor: "pointer", opacity: isStreaming ? 0.5 : 1 }}>
                      {cameras.map((cam, i) => <option key={cam.deviceId} value={cam.deviceId}>{cam.label || `Camera ${i + 1}`}</option>)}
                    </select>
                    <ChevronDown style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "hsl(222 25% 50%)", pointerEvents: "none" }} />
                  </div>
                )}
              </div>
              <button onClick={enumerateCameras} style={{ background: "none", border: "none", cursor: "pointer", color: "hsl(222 25% 50%)", padding: 4 }}><RefreshCw style={{ width: 13, height: 13 }} /></button>
            </div>

            {/* Stream button */}
            {isStreaming ? (
              <button onClick={handleStopStream} style={{ width: "100%", height: 54, background: "hsl(0 85% 40% / 0.3)", border: "1px solid hsl(0 85% 55% / 0.5)", borderRadius: 12, cursor: "pointer", color: "hsl(0 85% 75%)", fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 14, letterSpacing: "0.08em", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "all 0.2s" }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.5)"; }} onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "hsl(0 85% 40% / 0.3)"; }}>
                <Square style={{ width: 18, height: 18 }} /> Stop Stream
              </button>
            ) : (
              <button onClick={handleStartStream} disabled={isStarting || !cameraReady} style={{ width: "100%", height: 54, background: (!isStarting && cameraReady && !credsMissing) ? "linear-gradient(135deg, hsl(187 100% 52%) 0%, hsl(200 100% 45%) 100%)" : "hsl(222 40% 11%)", border: "none", borderRadius: 12, cursor: (!isStarting && cameraReady && !credsMissing) ? "pointer" : "not-allowed", color: (!isStarting && cameraReady && !credsMissing) ? "hsl(222 47% 4%)" : "hsl(222 25% 40%)", fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 14, letterSpacing: "0.08em", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: (!isStarting && cameraReady && !credsMissing) ? "0 0 28px hsl(187 100% 52% / 0.3)" : "none", transition: "all 0.2s" }}
                onMouseEnter={e => { if (!isStarting && cameraReady && !credsMissing) (e.currentTarget as HTMLElement).style.filter = "brightness(1.1)"; }} onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = "none"; }}>
                {isStarting ? <><Loader2 style={{ width: 18, height: 18, animation: "spin 1s linear infinite" }} /> StartingÃ¢ÂÂ¦</>
                  : credsMissing ? <><Settings style={{ width: 18, height: 18 }} /> Open Settings to Set Keys</>
                  : !cameraReady ? <><Camera style={{ width: 18, height: 18 }} /> Enable Camera First</>
                  : <><Play style={{ width: 18, height: 18 }} /> Stream Now</>}
              </button>
            )}

            {/* OBS guide */}
            <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 12, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <Monitor style={{ width: 14, height: 14, color: C }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: "hsl(190 80% 96%)", fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em" }}>OBS Setup</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[
                  ["1", "Start your stream here first Ã¢ÂÂ audio sync is automatic"],
                  ["2", "Click the OBS button above the video to open a clean output window"],
                  ["3", "In OBS: Sources Ã¢ÂÂ + Ã¢ÂÂ Window Capture Ã¢ÂÂ select the OBS output window"],
                  ["4", "No separate mic needed Ã¢ÂÂ audio is pre-synced automatically"],
                ].map(([n, text]) => (
                  <div key={n} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <span style={{ width: 18, height: 18, borderRadius: "50%", flexShrink: 0, background: "hsl(187 100% 52% / 0.15)", color: C, fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{n}</span>
                    <p style={{ fontSize: 12, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5 }}>{text}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Ã¢ÂÂÃ¢ÂÂ Right sidebar Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

            {/* Style presets */}
            <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 16 }}>
              <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", marginBottom: 12 }}>AI Style Preset</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                {STYLES.map(s => (
                  <button key={s.id} onClick={() => setSelectedStyle(s.id)} style={{ padding: "7px 4px", borderRadius: 8, cursor: "pointer", background: selectedStyle === s.id ? `${s.color}22` : "hsl(222 40% 8%)", border: `1px solid ${selectedStyle === s.id ? s.color + "66" : "hsl(222 40% 12%)"}`, color: selectedStyle === s.id ? s.color : "hsl(222 25% 55%)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", fontFamily: "'Orbitron',monospace", transition: "all 0.15s", boxShadow: selectedStyle === s.id ? `0 0 12px ${s.color}33` : "none" }}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom prompt */}
            <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 16 }}>
              <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", marginBottom: 8 }}>Custom Prompt</p>
              <textarea value={customPrompt} onChange={e => setCustomPrompt(e.target.value)} placeholder={style.prompt} rows={3} style={{ width: "100%", padding: 10, borderRadius: 8, resize: "vertical", background: "hsl(222 47% 4%)", border: "1px solid hsl(222 40% 14%)", color: "hsl(190 80% 96%)", fontSize: 12, fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5, outline: "none" }}
                onFocus={e => { e.target.style.borderColor = "hsl(187 100% 52% / 0.5)"; }} onBlur={e => { e.target.style.borderColor = "hsl(222 40% 14%)"; }} />
              {customPrompt && <button onClick={() => setCustomPrompt("")} style={{ marginTop: 6, fontSize: 11, color: "hsl(222 25% 50%)", background: "none", border: "none", cursor: "pointer", fontFamily: "'Rajdhani',sans-serif" }}>Ã¢ÂÂº Reset to preset</button>}
            </div>

            {/* Auto Audio Sync */}
            <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace" }}>Audio Sync</p>
                <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 20, background: audioActive ? "hsl(187 100% 52% / 0.12)" : "hsl(222 40% 9%)", border: `1px solid ${audioActive ? "hsl(187 100% 52% / 0.35)" : "hsl(222 40% 14%)"}` }}>
                  {audioActive
                    ? <Wifi style={{ width: 10, height: 10, color: C }} />
                    : <WifiOff style={{ width: 10, height: 10, color: "hsl(222 25% 40%)" }} />}
                  <span style={{ fontSize: 9, fontWeight: 700, fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em", color: audioActive ? C : "hsl(222 25% 40%)" }}>
                    {audioActive ? "AUTO" : "IDLE"}
                  </span>
                </div>
              </div>

              {audioActive ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                      <Mic style={{ width: 11, height: 11, color: C }} />
                      <span style={{ fontSize: 11, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif" }}>Microphone</span>
                    </div>
                    <div style={{ height: 6, background: "hsl(222 40% 11%)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", borderRadius: 3, transition: "width 0.05s", width: `${vuLevel}%`, background: vuLevel > 80 ? "hsl(0 85% 55%)" : vuLevel > 50 ? "hsl(40 100% 55%)" : C }} />
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderRadius: 8, background: "hsl(222 40% 8%)", border: "1px solid hsl(222 40% 12%)" }}>
                    <span style={{ fontSize: 12, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif" }}>Detected Delay</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: C, fontFamily: "'Orbitron',monospace" }}>{syncDelay.toFixed(2)}s</span>
                  </div>
                  <p style={{ fontSize: 11, color: "hsl(222 25% 40%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5 }}>
                    Continuously measuring audio-to-video latency via signal cross-correlation and adjusting in real time.
                  </p>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <p style={{ fontSize: 12, color: "hsl(222 25% 45%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.5 }}>
                    When you click <strong style={{ color: "hsl(190 80% 80%)" }}>Stream Now</strong>, your default microphone is automatically detected and the audio delay is calibrated to match the AI video output in real time.
                  </p>
                </div>
              )}
            </div>

            {/* Reference image */}
            <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 16 }}>
              <p style={{ fontSize: 10, fontWeight: 700, color: C, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", marginBottom: 10 }}>Reference Image</p>
              {refImagePreview ? (
                <div style={{ position: "relative" }}>
                  <img src={refImagePreview} alt="Ref" style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", borderRadius: 8, border: "1px solid hsl(187 100% 52% / 0.3)" }} />
                  <button onClick={() => { setRefImagePreview(null); setRefImageB64(null); }} style={{ position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: "50%", background: "rgba(220,38,38,0.8)", border: "none", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><X style={{ width: 10, height: 10 }} /></button>
                </div>
              ) : (
                <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "18px 12px", borderRadius: 10, cursor: "pointer", background: "hsl(222 40% 8%)", border: "1px dashed hsl(222 40% 16%)", transition: "all 0.2s" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "hsl(187 100% 52% / 0.4)"; }} onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "hsl(222 40% 16%)"; }}>
                  <Image style={{ width: 22, height: 22, color: "hsl(222 25% 40%)" }} />
                  <p style={{ fontSize: 12, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", textAlign: "center" }}>Upload a face reference to guide the AI</p>
                  <input type="file" accept="image/*" onChange={handleRefImage} style={{ display: "none" }} />
                </label>
              )}
            </div>

            {/* Shortcuts */}
            <div style={{ background: "hsl(222 44% 6%)", border: "1px solid hsl(222 40% 11%)", borderRadius: 14, padding: 14 }}>
              <p style={{ fontSize: 10, fontWeight: 700, color: "hsl(222 25% 40%)", textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", marginBottom: 10 }}>Shortcuts</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[
                  ["F", "Fullscreen AI output (in-app overlay)"],
                  ["Esc", "Stop stream & exit fullscreen"],
                ].map(([key, desc]) => (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <kbd style={{ padding: "2px 7px", borderRadius: 5, background: "hsl(222 40% 9%)", border: "1px solid hsl(222 40% 16%)", color: "hsl(190 80% 90%)", fontSize: 10, fontFamily: "monospace", fontWeight: 700 }}>{key}</kbd>
                    <span style={{ fontSize: 11, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif" }}>{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>
    </AppLayout>
  );
}
