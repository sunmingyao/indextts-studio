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

export interface TranslateStatus {
  status: "idle" | "loading" | "ready" | "failed" | "stopped";
  ready: boolean;
  error: string | null;
  loadSeconds: number | null;
  missing: string[];
  models: Record<string, string>;
}

export interface SubtitleCue {
  start: number;
  end: number;
  source: string;
  translation: string;
  timestamps: "aligner" | "vad";
  refusal?: boolean;
  translation_mode?: string;
}

export type SubtitleJobStatus =
  | "uploading"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export interface SubtitleJob {
  id: string;
  status: SubtitleJobStatus;
  stage: string;
  step: number;
  progress: number;
  message: string;
  video_name: string;
  source: string;
  target: string;
  silence: number;
  duration: number | null;
  elapsed: number | null;
  rtf: number | null;
  cue_count: number;
  cues: SubtitleCue[];
  timings?: Record<string, number>;
  filtered?: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface InterpretResult {
  source: string;
  translation: string;
  language: string;
  elapsed: number;
}