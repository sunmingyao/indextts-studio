import { contextBridge, ipcRenderer } from "electron";

function arg(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

const port = arg("api-port");
const token = arg("api-token");

contextBridge.exposeInMainWorld("appConfig", {
  apiBase: port ? `http://127.0.0.1:${port}` : "http://127.0.0.1:8765",
  apiToken: token,
});

contextBridge.exposeInMainWorld("appBridge", {
  setMiniMode: (enabled: boolean) => ipcRenderer.invoke("window:set-mini", enabled),
});