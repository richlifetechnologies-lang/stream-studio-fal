import { app, BrowserWindow, shell, session, ipcMain, dialog } from "electron";
import https from "https";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

const GITHUB_OWNER = "richlifetechnologies-lang";
const GITHUB_REPO  = "stream-studio";

// ─── Asset pattern for the current platform + architecture ─────────────────
function getAssetPattern(): RegExp {
  if (process.platform === "win32") return /StreamStudio-Setup-.*\.exe$/i;
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return new RegExp(`StreamStudio-.*-${arch}\\.dmg`, "i");
  }
  return /StreamStudio-.*\.AppImage$/i;
}

// ─── Generic HTTPS GET with redirect following ────────────────────────────────
function httpsGet(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = (lib as typeof https).get(
      url,
      { headers: { "User-Agent": `stream-studio/${app.getVersion()}`, ...headers } },
      (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          resolve(httpsGet(res.headers.location, headers));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
  });
}

// ─── Streaming download with progress ────────────────────────────────────────
function downloadFile(
  url: string,
  destPath: string,
  onProgress: (percent: number, transferred: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    function doGet(u: string) {
      const lib = u.startsWith("https") ? https : http;
      (lib as typeof https).get(
        u,
        { headers: { "User-Agent": `stream-studio/${app.getVersion()}` } },
        (res) => {
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            doGet(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed with status ${res.statusCode}`));
            return;
          }

          const total = parseInt(res.headers["content-length"] ?? "0", 10);
          let transferred = 0;
          const dest = fs.createWriteStream(destPath);

          res.on("data", (chunk: Buffer) => {
            transferred += chunk.length;
            if (total > 0) onProgress(Math.round((transferred / total) * 100), transferred, total);
          });

          res.pipe(dest);
          dest.on("finish", resolve);
          dest.on("error", reject);
          res.on("error", (err) => { dest.destroy(); reject(err); });
        }
      ).on("error", reject);
    }
    doGet(url);
  });
}

// ─── Version comparison (semver-lite: major.minor.patch) ─────────────────────
function isNewer(remote: string, local: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [rMaj, rMin, rPat] = parse(remote);
  const [lMaj, lMin, lPat] = parse(local);
  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPat > lPat;
}

// ─── In-app updater state ─────────────────────────────────────────────────────
let pendingInstallerPath: string | null = null;
let latestDownloadUrl:    string | null = null;
let latestVersion:        string | null = null;

async function checkForUpdate(win: BrowserWindow) {
  try {
    const buf = await httpsGet(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      { Accept: "application/vnd.github+json" }
    );
    const release = JSON.parse(buf.toString("utf8")) as {
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    };

    const remoteVer = release.tag_name.replace(/^v/, "");
    const localVer  = app.getVersion();

    if (!isNewer(remoteVer, localVer)) return;

    const pattern = getAssetPattern();
    const asset   = release.assets.find((a) => pattern.test(a.name));
    if (!asset) return;

    latestVersion     = remoteVer;
    latestDownloadUrl = asset.browser_download_url;

    win.webContents.send("update-available", { version: remoteVer });
  } catch {
    // Best-effort — silently ignore
  }
}

async function startInAppDownload(win: BrowserWindow, overrideUrl?: string) {
  const downloadUrl = overrideUrl ?? latestDownloadUrl;
  if (!downloadUrl) return;

  try {
    // Infer a filename from the URL
    const filename    = decodeURIComponent(path.basename(new URL(downloadUrl).pathname));
    const destPath    = path.join(os.tmpdir(), filename);

    await downloadFile(
      downloadUrl,
      destPath,
      (percent, transferred, total) => {
        if (!win.isDestroyed()) {
          win.webContents.send("download-progress", { percent, transferred, total });
        }
      }
    );

    pendingInstallerPath = destPath;
    if (!win.isDestroyed()) win.webContents.send("update-downloaded");
  } catch {
    // Silently ignore download errors
  }
}

// ─── IPC: trigger update download ────────────────────────────────────────────
ipcMain.on("download-update", () => {
  if (mainWindow) startInAppDownload(mainWindow);
});

// ─── IPC: quit and run the downloaded installer ───────────────────────────────
ipcMain.on("quit-and-install", () => {
  if (!pendingInstallerPath) return;
  shell.openPath(pendingInstallerPath).then(() => {
    app.quit();
  }).catch(() => {
    app.quit();
  });
});

// ─── IPC: open-external — intercept old v1.4.0 update flow ───────────────────
// v1.4.0 compiled the following into its renderer: ipcRenderer.send("open-external", url)
// That old call is now caught here: if the URL looks like one of our installers, we
// download it in-app; otherwise we fall back to shell.openExternal as before.
ipcMain.on("open-external", (_event, url: string) => {
  if (typeof url !== "string") return;

  const isOurInstaller =
    url.includes(`github.com/${GITHUB_OWNER}/${GITHUB_REPO}`) &&
    getAssetPattern().test(decodeURIComponent(url));

  if (isOurInstaller && mainWindow) {
    // Inform the renderer that an in-app update is starting
    latestDownloadUrl = url;
    mainWindow.webContents.send("update-available", { version: latestVersion ?? "latest" });
    startInAppDownload(mainWindow, url);
  } else {
    shell.openExternal(url).catch(() => {});
  }
});

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "Stream Studio",
    backgroundColor: "#070d1a",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://*.decart.ai wss://*.decart.ai https://*.livekit.io wss://*.livekit.io https://fonts.googleapis.com https://fonts.gstatic.com; media-src *; connect-src *;",
        ],
      },
    });
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.webContents.on("did-fail-load", () => {
    if (!isDev && mainWindow) {
      mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
    }
  });

  // Kick off update check 5 s after the window is ready
  mainWindow.webContents.once("did-finish-load", () => {
    if (!isDev && mainWindow) {
      setTimeout(() => checkForUpdate(mainWindow!), 5000);
    }
  });
}

// ─── macOS first-launch Gatekeeper notice ────────────────────────────────────
function showMacFirstLaunchNotice() {
  if (process.platform !== "darwin" || isDev) return;
  const flagPath = path.join(app.getPath("userData"), ".mac-first-launch-shown");
  if (fs.existsSync(flagPath)) return;
  try { fs.writeFileSync(flagPath, "1"); } catch { /* ignore */ }

  // Show after a short delay so the window is fully painted
  setTimeout(() => {
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Welcome to Stream Studio",
      message: "One-time Mac setup complete",
      detail:
        "If macOS blocked this app when you first opened it, here's how to fix it:\n\n" +
        "1. Close Stream Studio\n" +
        "2. Right-click the app icon (or DMG) → Open\n" +
        "3. Click Open in the security dialog\n\n" +
        "You only need to do this once. After that it launches normally.\n\n" +
        "This happens because Stream Studio isn't signed with a paid Apple Developer certificate.",
      buttons: ["Got it"],
      defaultId: 0,
    });
  }, 2000);
}

app.whenReady().then(() => {
  createWindow();
  showMacFirstLaunchNotice();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
