import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform !== "darwin") {
  process.exit(0);
}

const plist = path.join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/Info.plist",
);
if (!fs.existsSync(plist)) {
  process.exit(0);
}

const plistBuddy = "/usr/libexec/PlistBuddy";
const values = {
  CFBundleName: "IndexTTS Studio",
  CFBundleDisplayName: "IndexTTS Studio",
};

for (const [key, value] of Object.entries(values)) {
  try {
    execFileSync(plistBuddy, ["-c", `Set :${key} ${value}`, plist]);
  } catch {
    try {
      execFileSync(plistBuddy, ["-c", `Add :${key} string ${value}`, plist]);
    } catch {
      // If this fails, the app still runs; packaged builds use productName.
    }
  }
}