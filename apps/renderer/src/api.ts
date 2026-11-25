import type {
  EnginesResponse,
  Job,
  Preset,
  TtsPayload,
  Voice,
} from "./types";

declare global {
  interface Window {
    appConfig?: {
      apiBase: string;
      apiToken: string;
    };
  }
}

const fallbackBase = (import.meta.env.VITE_API_BASE as string | undefined) || "http://127.0.0.1:8765";
const fallbackToken = (import.meta.env.VITE_API_TOKEN as string | undefined) || "";

export const apiBase = window.appConfig?.apiBase || fallbackBase;
export const apiToken = window.appConfig?.apiToken || fallbackToken;

export function withToken(url: string): string {
  if (!apiToken) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(apiToken)}`;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (apiToken) headers.set("X-App-Token", apiToken);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${apiBase}${path}`, { ...options, headers });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      detail = payload.detail || payload.error || detail;
    } catch {
      // ignore non-json error bodies
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export function getEngines(): Promise<EnginesResponse> {
  return request<EnginesResponse>("/api/engines");
}

export function activateEngine(id: string): Promise<EnginesResponse> {
  return request<EnginesResponse>(`/api/engines/${id}/activate`, { method: "POST" });
}

export function getVoices(kind: Voice["kind"]): Promise<Voice[]> {
  return request<Voice[]>(`/api/voices?kind=${encodeURIComponent(kind)}`);
}

export async function uploadVoice(
  file: File,
  name: string,
  kind: Voice["kind"],
): Promise<Voice> {
  const form = new FormData();
  form.append("file", file);
  form.append("name", name);
  form.append("consent", "true");
  form.append("kind", kind);
  return request<Voice>("/api/voices", { method: "POST", body: form });
}

export function copyVoice(
  voiceId: string,
  name: string,
  kind: Voice["kind"],
): Promise<Voice> {
  return request<Voice>(`/api/voices/${voiceId}/copy`, {
    method: "POST",
    body: JSON.stringify({ name, kind }),
  });
}

export function deleteVoice(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/voices/${id}`, { method: "DELETE" });
}

export function getPresets(): Promise<Preset[]> {
  return request<Preset[]>("/api/presets");
}

export function savePreset(name: string, payload: Record<string, unknown>): Promise<Preset> {
  return request<Preset>("/api/presets", {
    method: "POST",
    body: JSON.stringify({ name, payload }),
  });
}

export function deletePreset(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/presets/${id}`, { method: "DELETE" });
}

export function createJob(payload: TtsPayload): Promise<Job> {
  return request<Job>("/api/tts", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getJobs(): Promise<Job[]> {
  return request<Job[]>("/api/jobs");
}

export function cancelJob(id: string): Promise<Job> {
  return request<Job>(`/api/jobs/${id}/cancel`, { method: "POST" });
}

export function deleteJob(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/jobs/${id}`, { method: "DELETE" });
}

export function clearJobs(): Promise<{ ok: boolean; count: number }> {
  return request<{ ok: boolean; count: number }>("/api/jobs", { method: "DELETE" });
}

export async function streamJob(
  id: string,
  onState: (job: Job) => void,
  signal: AbortSignal,
): Promise<void> {
  const headers = new Headers();
  if (apiToken) headers.set("X-App-Token", apiToken);
  const response = await fetch(`${apiBase}/api/jobs/${id}/events`, { headers, signal });
  if (!response.ok || !response.body) {
    throw new Error(`任务进度订阅失败: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data) continue;
      try {
        onState(JSON.parse(data) as Job);
      } catch {
        // ignore malformed event
      }
    }
  }
}

export function voiceAudioUrl(voiceId: string): string {
  return withToken(`${apiBase}/api/voices/${voiceId}/audio`);
}

export function outputAudioUrl(path: string): string {
  return withToken(`${apiBase}${path}`);
}