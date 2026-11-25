import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function runOnce(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...options.env },
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
    child.on("error", reject);
  });
}

async function waitForUrl(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const vite = spawn(npx, ["vite", "--config", "apps/renderer/vite.config.ts"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env },
});

let electron = null;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electron && !electron.killed) electron.kill("SIGTERM");
  if (!vite.killed) vite.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}

vite.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[dev] Vite exited with ${code}`);
    shutdown(code || 1);
  }
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  await waitForUrl("http://127.0.0.1:5173");
  console.log("[dev] Vite ready, compiling Electron main process...");
  await runOnce(npx, ["tsc", "-p", "apps/desktop/tsconfig.json"]);
  console.log("[dev] launching Electron...");
  electron = spawn(npx, ["electron", "."], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" },
  });
  electron.on("exit", (code) => {
    console.log(`[dev] Electron exited with ${code}`);
    shutdown(code || 0);
  });
} catch (error) {
  console.error("[dev]", error instanceof Error ? error.message : error);
  shutdown(1);
}