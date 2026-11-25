export type EmotionMode = "reference" | "audio" | "vector" | "text";

export interface EngineInfo {
  id: string;
  label: string;
  description: string;
  languages: string[];
  emotionModes: EmotionMode[];
  supportsPronunciation: boolean;
  supportsDurationFactor: boolean;
  speedHint: string;
  active: boolean;
}

export interface EnginesResponse {
  active: string | null;
  status: "idle" | "loading" | "ready" | "failed" | "stopped";
  error: string | null;
  loadSeconds: number | null;
  engines: EngineInfo[];
}

export type VoiceKind = "voice" | "emotion";

export interface Voice {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  consent: boolean;
  kind: VoiceKind;
  created_at: string;
  audioUrl: string;
}

export interface EmotionPayload {
  mode: EmotionMode;
  alpha: number;
  vector?: number[];
  text?: string;
  audioVoiceId?: string;
}

export interface Job {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  engine: string;
  text: string;
  voice_id: string;
  voice_name: string;
  lang: string;
  duration_factor: number;
  emotion: EmotionPayload;
  advanced: Record<string, unknown>;
  audio_url: string | null;
  duration: number | null;
  elapsed: number | null;
  rtf: number | null;
  error: string | null;
  created_at: string;
}

export interface Preset {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface TtsPayload {
  text: string;
  voiceId: string;
  lang: string;
  durationFactor: number;
  emotion: EmotionPayload;
  advanced: Record<string, unknown>;
}

export const LANGUAGE_LABELS: Record<string, string> = {
  zh: "中文",
  en: "English",
  ja: "日本語",
  yue: "粤语",
  es: "Español",
  ar: "العربية",
};

export const EMOTION_LABELS: Record<EmotionMode, string> = {
  reference: "跟随参考音频",
  audio: "情感参考音频",
  vector: "8 维情感向量",
  text: "文本情感描述",
};

export const VECTOR_LABELS = ["喜", "怒", "哀", "惧", "厌恶", "低落", "惊喜", "平静"];