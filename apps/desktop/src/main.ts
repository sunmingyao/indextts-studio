import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  systemPreferences,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

let backend: ChildProcess | null = null;
let win: BrowserWindow | null = null;
let quitting = false;
let backendPort = 0;
let backendToken = "";
let miniMode = false;
let normalBounds: { x: number; y: number; width: number; height: number } | null = null;
let normalMinimumSize: [number, number] = [1080, 720];
let savedMenu: Menu | null = null;

const MINI_WIDTH = 760;
const MINI_HEIGHT = 76;

const projectRoot = path.resolve(__dirname, "../../..");
const codeRoot = app.isPackaged ? process.resourcesPath : projectRoot;
const runtimeRoot = app.isPackaged
  ? path.join(app.getPath("userData"), "runtime")
  : path.join(projectRoot, "runtime");
const dataRoot = app.isPackaged
  ? path.join(app.getPath("userData"), "data")
  : path.join(projectRoot, "data");
const backendPython =
  process.env.INDEXTTS_BACKEND_PYTHON ||
  path.join(runtimeRoot, "envs", "backend", "bin", "python");
const configPath =
  process.env.INDEXTTS_CONFIG ||
  (app.isPackaged
    ? path.join(process.resourcesPath, "config", "default.json")
    : path.join(projectRoot, "config", "default.json"));
const devServerUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.join(projectRoot, "build", "icon.png");
const appIconImage = fs.existsSync(appIconPath)
  ? nativeImage.createFromPath(appIconPath)
  : undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配本地端口"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function waitForHealth(port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const request = http.get(
        { hostname: "127.0.0.1", port, path: "/healthz", timeout: 1500 },
        (response) => {
          response.resume();
          if (response.statusCode === 200) {
            resolve();
            return;
          }
          retry();
        },
      );
      request.on("timeout", () => request.destroy());
      request.on("error", retry);
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error("后端启动超时，请查看 data/logs/backend.log"));
        return;
      }
      setTimeout(tryOnce, 600);
    };
    tryOnce();
  });
}

function missingRuntime(): string[] {
  const required = [
    backendPython,
    path.join(runtimeRoot, "envs", "mlx", "bin", "python"),
    path.join(runtimeRoot, "envs", "mps", "bin", "python"),
    path.join(runtimeRoot, "models", "mlx", "gpt_int8.safetensors"),
    path.join(runtimeRoot, "models", "mps", "checkpoints", "gpt.pth"),
  ];
  return required.filter((item) => !fs.existsSync(item));
}

function setupPage(iconDataUrl: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>正在准备 IndexTTS Studio</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(900px 520px at 50% -10%, #dff7ec, #f5f8f6 65%);
    font-family: "PingFang SC", "SF Pro Text", sans-serif; color: #1b2520; }
  .card { width: min(720px, calc(100vw - 48px)); background: #fff; border: 1px solid #e5ebe7;
    border-radius: 18px; padding: 22px; box-shadow: 0 20px 60px rgba(24, 52, 40, .12); }
  .head { display: flex; align-items: center; gap: 12px; }
  .head img { width: 46px; height: 46px; border-radius: 11px; }
  h1 { margin: 0; font-size: 16px; font-weight: 600; }
  p { margin: 4px 0 0; color: #6d7a72; font-size: 11px; }
  #status { margin: 16px 0 8px; color: #0f9f73; font-size: 12px; font-weight: 600; }
  pre { margin: 0; height: 280px; overflow: auto; padding: 12px; border-radius: 10px;
    background: #f8faf9; border: 1px solid #e5ebe7; color: #53605a; font-size: 10px;
    line-height: 1.55; white-space: pre-wrap; }
  .note { margin-top: 10px; color: #9aa69f; font-size: 10px; }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      ${iconDataUrl ? `<img src="${iconDataUrl}" alt="" />` : ""}
      <div>
        <h1>正在准备运行环境</h1>
        <p>首次启动需要安装 Python 环境并下载模型，约 15GB，请保持网络连接。</p>
      </div>
    </div>
    <div id="status">准备中...</div>
    <pre id="log"></pre>
    <div class="note">这一窗口在初始化完成前请不要关闭。</div>
  </div>
<script>
  const log = document.getElementById("log");
  window.__setupLog = (line) => {
    log.textContent += line + "\\n";
    log.scrollTop = log.scrollHeight;
  };
  window.__setupDone = () => {
    document.getElementById("status").textContent = "初始化完成，正在启动应用...";
  };
</script>
</body>
</html>`;
}

async function ensureRuntime(): Promise<void> {
  const missing = process.env.INDEXTTS_FORCE_SETUP === "1" ? ["forced"] : missingRuntime();
  if (!missing.length) return;

  const setupScript = app.isPackaged
    ? path.join(process.resourcesPath, "scripts", "setup-runtime.sh")
    : path.join(projectRoot, "scripts", "setup-runtime.sh");
  const uvPath = process.env.INDEXTTS_UV || (app.isPackaged
    ? path.join(process.resourcesPath, "bin", "uv")
    : path.join(projectRoot, "bin", "uv"));

  if (!fs.existsSync(setupScript)) {
    throw new Error(`运行环境初始化脚本不存在：${setupScript}`);
  }
  if (!fs.existsSync(uvPath)) {
    throw new Error(`uv 不存在：${uvPath}\n请重新安装应用，或设置 INDEXTTS_UV`);
  }

  const setupWin = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 640,
    minHeight: 480,
    title: "IndexTTS Studio - 初始化",
    backgroundColor: "#f5f8f6",
    icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await setupWin.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(setupPage(appIconImage?.toDataURL() || ""))}`,
  );

  let closedByUser = false;
  let lastLog = "";
  const append = (line: string) => {
    if (!line) return;
    lastLog = `${lastLog}\n${line}`.slice(-4000);
    if (!setupWin.isDestroyed()) {
      void setupWin.webContents
        .executeJavaScript(`window.__setupLog(${JSON.stringify(line)})`)
        .catch(() => undefined);
    }
  };

  append(`缺少：${missing.join(", ")}`);
  const child = spawn("/bin/bash", [setupScript], {
    cwd: codeRoot,
    env: {
      ...process.env,
      INDEXTTS_CODE_ROOT: codeRoot,
      INDEXTTS_RUNTIME_ROOT: runtimeRoot,
      INDEXTTS_UV: uvPath,
      HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
      PYPI_INDEX_URL: process.env.PYPI_INDEX_URL || "https://mirrors.aliyun.com/pypi/simple",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  setupWin.on("closed", () => {
    closedByUser = true;
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) append(line);
  });
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) append(line);
  });

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (closedByUser) {
        reject(new Error("初始化被关闭"));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`初始化失败（exit ${code}）\n${lastLog.slice(-1800)}`));
      }
    });
  });

  if (!setupWin.isDestroyed()) {
    await setupWin.webContents.executeJavaScript("window.__setupDone()").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 700));
    setupWin.close();
  }
}

async function startBackend(): Promise<{ port: number; token: string }> {
  if (!fs.existsSync(backendPython)) {
    throw new Error(
      `后端 Python 环境不存在：${backendPython}\n请先运行 runtime 初始化：npm run runtime:setup`,
    );
  }
  fs.mkdirSync(path.join(dataRoot, "logs"), { recursive: true });
  const logPath = path.join(dataRoot, "logs", "backend.log");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  logStream.write(`\n=== ${new Date().toISOString()} start backend ===\n`);

  const port = await freePort();
  const token = crypto.randomUUID();
  backendPort = port;
  backendToken = token;
  backend = spawn(backendPython, ["-m", "backend.app.main"], {
    cwd: codeRoot,
    env: {
      ...process.env,
      INDEXTTS_PORT: String(port),
      INDEXTTS_TOKEN: token,
      INDEXTTS_CONFIG: configPath,
      INDEXTTS_RUNTIME_ROOT: runtimeRoot,
      INDEXTTS_DATA_DIR: dataRoot,
      PYTHONPATH: codeRoot,
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  backend.stdout?.on("data", (chunk) => {
    logStream.write(chunk);
    if (isDev) process.stdout.write(`[backend] ${chunk}`);
  });
  backend.stderr?.on("data", (chunk) => {
    logStream.write(chunk);
    if (isDev) process.stderr.write(`[backend] ${chunk}`);
  });
  backend.on("exit", (code, signal) => {
    logStream.write(`\n=== backend exited code=${code} signal=${signal} ===\n`);
    if (!quitting && win) {
      void dialog.showMessageBox({
        type: "error",
        title: "本地推理服务已退出",
        message: "IndexTTS Studio 后端已退出",
        detail: `backend 进程退出（code=${code}, signal=${signal}）。\n日志：${logPath}`,
        icon: appIconImage,
      });
    }
  });

  await waitForHealth(port);
  return { port, token };
}

ipcMain.handle("window:set-mini", (event, enabled: boolean) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target) return false;
  if (enabled === miniMode) return true;

  if (enabled) {
    normalBounds = target.getBounds();
    normalMinimumSize = target.getMinimumSize() as [number, number];
    savedMenu = Menu.getApplicationMenu();
    miniMode = true;
    Menu.setApplicationMenu(null);
    target.setMinimumSize(0, 0);
    target.setResizable(false);
    target.setMaximizable(false);
    target.setMinimizable(false);
    target.setFullScreenable(false);
    target.setAlwaysOnTop(true, "floating");
    target.setHasShadow(false);
    if (process.platform === "darwin") {
      target.setWindowButtonVisibility(false);
    }
    const area = screen.getPrimaryDisplay().workArea;
    target.setBounds({
      x: area.x + area.width - MINI_WIDTH - 24,
      y: area.y + 24,
      width: MINI_WIDTH,
      height: MINI_HEIGHT,
    });
    target.focus();
    return true;
  }

  miniMode = false;
  target.setAlwaysOnTop(false);
  target.setResizable(true);
  target.setMaximizable(true);
  target.setMinimizable(true);
  target.setFullScreenable(true);
  target.setHasShadow(true);
  if (process.platform === "darwin") {
    target.setWindowButtonVisibility(true);
  }
  target.setMinimumSize(normalMinimumSize[0], normalMinimumSize[1]);
  if (normalBounds) {
    target.setBounds(normalBounds);
  }
  if (savedMenu) {
    Menu.setApplicationMenu(savedMenu);
    savedMenu = null;
  }
  target.focus();
  return true;
});

async function createWindow(port: number, token: string): Promise<void> {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#f7faf8",
    icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 18, y: 15 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--api-port=${port}`, `--api-token=${token}`],
    },
  });

  if (isDev) {
    await win.loadURL(devServerUrl);
    if (process.env.INDEXTTS_DEVTOOLS === "1") {
      win.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    await win.loadFile(path.join(projectRoot, "dist", "renderer", "index.html"));
  }

  win.on("closed", () => {
    win = null;
  });
}

function stopBackend(): void {
  const child = backend;
  backend = null;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 5000);
  timer.unref();
}

app.setName("IndexTTS Studio");
app.setAppUserModelId("com.indextts.studio");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer.getSources({ types: ["screen"] }).then(
          (sources) => {
            if (!sources.length) {
              callback(null as never);
              return;
            }
            callback({ video: sources[0], audio: "loopback" });
          },
        ).catch((error) => {
          console.error(
            "[display-media] getSources failed",
            error,
            "screenAccess=",
            process.platform === "darwin"
              ? systemPreferences.getMediaAccessStatus("screen")
              : "n/a",
          );
          callback(null as never);
        });
      },
      { useSystemPicker: false },
    );

    if (process.platform === "darwin" && app.dock && fs.existsSync(appIconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(appIconPath));
    }
    app.setAboutPanelOptions({
      applicationName: "IndexTTS Studio",
      applicationVersion: app.getVersion(),
      version: app.getVersion(),
      iconPath: appIconPath,
      copyright: "Local IndexTTS-2.5 studio",
    });
    try {
      await ensureRuntime();
      const { port, token } = await startBackend();
      await createWindow(port, token);
    } catch (error) {
      await dialog.showMessageBox({
        type: "error",
        title: "IndexTTS Studio 启动失败",
        message: "IndexTTS Studio 启动失败",
        detail: error instanceof Error ? error.message : String(error),
        icon: appIconImage,
      });
      app.quit();
    }
  });

  app.on("activate", () => {
    if (!win && backend && backendPort) {
      void createWindow(backendPort, backendToken);
    }
  });

  app.on("before-quit", () => {
    quitting = true;
    stopBackend();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}