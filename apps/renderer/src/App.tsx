import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  AudioLines,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Download,
  Gauge,
  History,
  Languages,
  ListMusic,
  Loader2,
  Mic,
  RefreshCw,
  Smile,
  Save,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Wand2,
  Zap,
} from "lucide-react";
import * as api from "./api";
import type {
  EmotionMode,
  EmotionPayload,
  EnginesResponse,
  Job,
  Preset,
  Voice,
  VoiceKind,
} from "./types";
import { EMOTION_LABELS, LANGUAGE_LABELS, VECTOR_LABELS } from "./types";
import AudioPicker from "./components/AudioPicker";
import TranslateWorkspace from "./components/TranslateWorkspace";
import appIcon from "./assets/app-icon.png";

const DEFAULT_ADVANCED: Record<string, unknown> = {
  do_sample: true,
  temperature: 0.8,
  top_p: 0.8,
  top_k: 30,
  num_beams: 1,
  repetition_penalty: 10,
  max_mel_tokens: 1500,
  max_text_tokens_per_segment: 120,
  n_timesteps: 25,
  cfg_rate: 0.7,
};

const DEFAULT_TEXT =
  "大家好，欢迎使用 IndexTTS Studio。这是一段本地生成的中文语音，支持零样本音色克隆、情感控制和语速调节。";

function formatTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function StatusDot({ status }: { status: string }) {
  const ready = status === "ready";
  const loading = status === "loading" || status === "idle";
  return (
    <span className={`status-dot ${ready ? "ready" : loading ? "loading" : "failed"}`}>
      <span />
      {ready ? "引擎就绪" : loading ? "引擎加载中" : "引擎异常"}
    </span>
  );
}

function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => Promise<void> | void;
}

export default function App() {
  const [engines, setEngines] = useState<EnginesResponse | null>(null);
  const [workspace, setWorkspace] = useState<"tts" | "translate">("tts");
  const [translateBusy, setTranslateBusy] = useState(false);
  const [miniMode, setMiniMode] = useState(false);
  const [voiceLibrary, setVoiceLibrary] = useState<Voice[]>([]);
  const [emotionLibrary, setEmotionLibrary] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState("");
  const [emotionVoiceId, setEmotionVoiceId] = useState("");
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const [emotionPickerOpen, setEmotionPickerOpen] = useState(false);
  const [draftVoice, setDraftVoice] = useState<Voice | null>(null);
  const [draftFile, setDraftFile] = useState<File | null>(null);
  const [saveAsSource, setSaveAsSource] = useState<Voice | null>(null);
  const [saveAsName, setSaveAsName] = useState("");
  const [saveAsBusy, setSaveAsBusy] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetSaving, setPresetSaving] = useState(false);
  const draftUrlRef = useRef<string | null>(null);
  const [text, setText] = useState(DEFAULT_TEXT);
  const [lang, setLang] = useState("zh");
  const [durationFactor, setDurationFactor] = useState(1);
  const [emotionMode, setEmotionMode] = useState<EmotionMode>("reference");
  const [emoAlpha, setEmoAlpha] = useState(0.8);
  const [emoVector, setEmoVector] = useState<number[]>(Array(8).fill(0));
  const [emoText, setEmoText] = useState("");
  const [advanced, setAdvanced] = useState<Record<string, unknown>>(DEFAULT_ADVANCED);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [history, setHistory] = useState<Job[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<AbortController | null>(null);

  const activeEngine = useMemo(
    () => engines?.engines.find((engine) => engine.active) || null,
    [engines],
  );
  const supportsEmotion = Boolean(activeEngine && activeEngine.emotionModes.length > 1);
  const isReady = engines?.status === "ready" && Boolean(activeEngine);
  const selectedVoice =
    draftVoice && draftVoice.id === voiceId
      ? draftVoice
      : voiceLibrary.find((voice) => voice.id === voiceId);
  const isDraftSelected = Boolean(draftVoice && draftVoice.id === voiceId);
  const voicePickerLibrary = draftVoice ? [draftVoice, ...voiceLibrary] : voiceLibrary;
  const audioSrc = job?.audio_url ? api.outputAudioUrl(job.audio_url) : "";

  const refreshEngines = useCallback(async () => {
    try {
      const data = await api.getEngines();
      setEngines(data);
      if (data.error) setError(data.error);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  }, []);

  const refreshVoices = useCallback(async () => {
    try {
      const [voices, emotions] = await Promise.all([
        api.getVoices("voice"),
        api.getVoices("emotion"),
      ]);
      setVoiceLibrary(voices);
      setEmotionLibrary(emotions);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await api.getJobs());
    } catch {
      // history is non-critical
    }
  }, []);

  const refreshPresets = useCallback(async () => {
    try {
      setPresets(await api.getPresets());
    } catch {
      // presets are non-critical
    }
  }, []);

  useEffect(() => {
    void refreshEngines();
    void refreshVoices();
    void refreshHistory();
    void refreshPresets();
    return () => streamRef.current?.abort();
  }, [refreshEngines, refreshHistory, refreshPresets, refreshVoices]);

  useEffect(() => {
    if (!engines || engines.status === "ready") return;
    const timer = window.setInterval(() => void refreshEngines(), 1500);
    return () => window.clearInterval(timer);
  }, [engines, refreshEngines]);

  useEffect(() => {
    if (!activeEngine) return;
    if (!activeEngine.languages.includes(lang)) setLang(activeEngine.languages[0]);
    if (!activeEngine.emotionModes.includes(emotionMode)) setEmotionMode("reference");
  }, [activeEngine, lang, emotionMode]);

  useEffect(() => {
    if (draftVoice && voiceId === draftVoice.id) return;
    if (!voiceId && voiceLibrary.length) setVoiceId(voiceLibrary[0].id);
    if (voiceLibrary.length && !voiceLibrary.some((voice) => voice.id === voiceId)) {
      setVoiceId(voiceLibrary[0].id);
    }
  }, [draftVoice, voiceId, voiceLibrary]);

  useEffect(() => {
    if (!emotionVoiceId && emotionLibrary.length) {
      setEmotionVoiceId(emotionLibrary[0].id);
    }
    if (emotionLibrary.length && !emotionLibrary.some((voice) => voice.id === emotionVoiceId)) {
      setEmotionVoiceId(emotionLibrary[0].id);
    }
  }, [emotionVoiceId, emotionLibrary]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    return () => {
      if (draftUrlRef.current) URL.revokeObjectURL(draftUrlRef.current);
    };
  }, []);

  async function handleSwitch(engineId: string) {
    if (!engines || switching) return;
    if (workspace === "tts" && engineId === engines.active) return;
    handleMiniMode(false);
    setWorkspace("tts");
    setSwitching(engineId);
    setError("");
    try {
      const data = await api.activateEngine(engineId);
      setEngines(data);
      const label = data.engines.find((item) => item.id === data.active)?.label || engineId;
      setNotice(`${label} 已就绪`);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
      await refreshEngines();
    } finally {
      setSwitching(null);
    }
  }

  function handleTranslateMode() {
    if (busy) return;
    setWorkspace("translate");
    setError("");
  }

  function handleMiniMode(enabled: boolean) {
    setMiniMode(enabled);
    void window.appBridge?.setMiniMode(enabled).catch((exc) => {
      setError(exc instanceof Error ? exc.message : String(exc));
    });
  }

  function clearDraft() {
    if (draftUrlRef.current) {
      URL.revokeObjectURL(draftUrlRef.current);
      draftUrlRef.current = null;
    }
    setDraftVoice(null);
    setDraftFile(null);
  }

  function handleUpload(file: File, name?: string) {
    const defaultName = name || file.name.replace(/\.[^.]+$/, "") || "参考音频";
    if (draftUrlRef.current) URL.revokeObjectURL(draftUrlRef.current);
    const url = URL.createObjectURL(file);
    draftUrlRef.current = url;
    const draft: Voice = {
      id: `__draft_${Date.now()}`,
      name: defaultName,
      duration: 0,
      sampleRate: 22050,
      channels: 1,
      consent: true,
      kind: "voice",
      created_at: new Date().toISOString(),
      audioUrl: url,
    };
    setDraftFile(file);
    setDraftVoice(draft);
    setVoiceId(draft.id);
    setNotice("音频已载入，点三个竖点可保存为音色参考或情感参考");

    const audio = new Audio(url);
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) {
        setDraftVoice((current) =>
          current && current.id === draft.id
            ? { ...current, duration: audio.duration }
            : current,
        );
      }
    };
  }

  async function handleDeleteVoice(voice: Voice) {
    if (draftVoice && voice.id === draftVoice.id) {
      clearDraft();
      setVoiceId("");
      setNotice("已移除未保存的音频");
      return;
    }
    setConfirmState({
      title: "删除参考音频",
      message: `将从库中删除「${voice.name}」，对应音频文件也会一起删除。`,
      confirmLabel: "删除",
      danger: true,
      action: async () => {
        try {
          await api.deleteVoice(voice.id);
          await refreshVoices();
          if (voiceId === voice.id) setVoiceId("");
          if (emotionVoiceId === voice.id) setEmotionVoiceId("");
          setNotice("已从库中删除");
        } catch (exc) {
          setError(exc instanceof Error ? exc.message : String(exc));
        }
      },
    });
  }

  function openSaveAs(voice: Voice) {
    setSaveAsSource(voice);
    setSaveAsName(voice.name);
    setSaveAsBusy(false);
  }

  async function submitSaveAs(kind: VoiceKind) {
    if (!saveAsSource) return;
    setSaveAsBusy(true);
    setError("");
    try {
      const name = saveAsName.trim() || saveAsSource.name;
      const isDraft = Boolean(draftFile && draftVoice && saveAsSource.id === draftVoice.id);
      const voice = isDraft && draftFile
        ? await api.uploadVoice(draftFile, name, kind)
        : await api.copyVoice(saveAsSource.id, name, kind);
      await refreshVoices();
      if (kind === "voice") {
        setVoiceId(voice.id);
      } else {
        setEmotionVoiceId(voice.id);
        if (isDraft && voiceId === saveAsSource.id) setVoiceId("");
      }
      if (isDraft) clearDraft();
      setSaveAsSource(null);
      setNotice(
        kind === "voice"
          ? `已保存音色参考「${voice.name}」`
          : `已保存情感参考「${voice.name}」`,
      );
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setSaveAsBusy(false);
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const stamp = new Date()
          .toLocaleTimeString("zh-CN", { hour12: false })
          .replace(/:/g, "-");
        void handleUpload(
          new File([blob], `recording-${stamp}.webm`, { type: blob.type }),
          `录音 ${stamp}`,
        );
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (exc) {
      setError(`无法访问麦克风: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  function buildEmotion(): EmotionPayload {
    const emotion: EmotionPayload = { mode: emotionMode, alpha: emoAlpha };
    if (emotionMode === "vector") emotion.vector = emoVector;
    if (emotionMode === "text") emotion.text = emoText;
    if (emotionMode === "audio") emotion.audioVoiceId = emotionVoiceId;
    return emotion;
  }

  async function handleGenerate() {
    if (!isReady) {
      setError("引擎尚未就绪，请稍等");
      return;
    }
    if (!voiceId) {
      setError("请先选择或上传一个音色参考音频");
      return;
    }
    if (isDraftSelected) {
      setError("这段音频还没有保存，请先用三个竖点保存为参考音频");
      return;
    }
    if (!text.trim()) {
      setError("请输入要合成的文本");
      return;
    }
    setBusy(true);
    setError("");
    setJob(null);
    streamRef.current?.abort();
    const controller = new AbortController();
    streamRef.current = controller;
    try {
      const created = await api.createJob({
        text: text.trim(),
        voiceId,
        lang,
        durationFactor,
        emotion: buildEmotion(),
        advanced,
      });
      setJob(created);
      await api.streamJob(created.id, (state) => setJob(state), controller.signal);
      await refreshHistory();
    } catch (exc) {
      if (!controller.signal.aborted) {
        setError(exc instanceof Error ? exc.message : String(exc));
        await refreshHistory();
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!job) return;
    try {
      setJob(await api.cancelJob(job.id));
      await refreshHistory();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  }

  function handleDeleteJob(item: Job) {
    setConfirmState({
      title: "删除历史记录",
      message: "这条历史记录和对应的生成音频会被删除，无法恢复。",
      confirmLabel: "删除",
      danger: true,
      action: async () => {
        try {
          await api.deleteJob(item.id);
          await refreshHistory();
          if (job?.id === item.id) setJob(null);
          setNotice("历史记录已删除");
        } catch (exc) {
          setError(exc instanceof Error ? exc.message : String(exc));
        }
      },
    });
  }

  function handleClearHistory() {
    if (!history.length) return;
    setConfirmState({
      title: "清空全部历史",
      message: "所有历史记录和生成的音频文件都会被删除，无法恢复。",
      confirmLabel: "全部清除",
      danger: true,
      action: async () => {
        try {
          const result = await api.clearJobs();
          await refreshHistory();
          setJob(null);
          setNotice(`已清除 ${result.count} 条历史记录`);
        } catch (exc) {
          setError(exc instanceof Error ? exc.message : String(exc));
        }
      },
    });
  }

  function openPresetDialog() {
    setPresetName(`我的预设 ${presets.length + 1}`);
    setPresetDialogOpen(true);
  }

  async function submitPreset() {
    const name = presetName.trim();
    if (!name) return;
    setPresetSaving(true);
    try {
      await api.savePreset(name, {
        engine: activeEngine?.id,
        voiceId,
        text,
        lang,
        durationFactor,
        emotionMode,
        emoAlpha,
        emoVector,
        emoText,
        advanced,
      });
      await refreshPresets();
      setPresetDialogOpen(false);
      setNotice("预设已保存");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setPresetSaving(false);
    }
  }

  async function executeConfirm() {
    if (!confirmState) return;
    setConfirmBusy(true);
    try {
      await confirmState.action();
    } finally {
      setConfirmBusy(false);
      setConfirmState(null);
    }
  }

  function applyPreset(id: string) {
    setPresetId(id);
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;
    const payload = preset.payload as Record<string, unknown>;
    if (typeof payload.voiceId === "string") setVoiceId(payload.voiceId);
    if (typeof payload.text === "string") setText(payload.text);
    if (typeof payload.lang === "string") setLang(payload.lang);
    if (typeof payload.durationFactor === "number") setDurationFactor(payload.durationFactor);
    if (typeof payload.emotionMode === "string") setEmotionMode(payload.emotionMode as EmotionMode);
    if (typeof payload.emoAlpha === "number") setEmoAlpha(payload.emoAlpha);
    if (Array.isArray(payload.emoVector)) setEmoVector(payload.emoVector as number[]);
    if (typeof payload.emoText === "string") setEmoText(payload.emoText);
    if (payload.advanced && typeof payload.advanced === "object") {
      setAdvanced(payload.advanced as Record<string, unknown>);
    }
    setNotice(`已应用预设「${preset.name}」`);
  }

  function updateAdvanced(key: string, value: unknown) {
    setAdvanced((current) => ({ ...current, [key]: value }));
  }

  if (!engines) {
    return (
      <div className="boot-screen">
        <div className="boot-mark"><AudioLines size={34} /></div>
        <h1>IndexTTS Studio</h1>
        <p>正在连接本地推理服务...</p>
        <Loader2 className="spin" size={22} />
        {error && <div className="error-box">{error}</div>}
      </div>
    );
  }

  return (
    <div className={`app-shell ${miniMode ? "app-mini" : ""}`}>
      <div className="window-drag">
        <div className="titlebar-left" />
        <div className="engine-switch">
          {engines.engines.map((engine) => (
            <button
              key={engine.id}
              className={`engine-pill ${workspace === "tts" && engine.active ? "active" : ""}`}
              onClick={() => void handleSwitch(engine.id)}
              disabled={Boolean(switching) || busy || translateBusy}
              title={engine.description}
            >
              {engine.id === "mlx" ? <Zap size={15} /> : <Sparkles size={15} />}
              <span>{engine.label}</span>
              {switching === engine.id && <Loader2 className="spin" size={13} />}
            </button>
          ))}
          <button
            className={`engine-pill ${workspace === "translate" ? "active" : ""}`}
            onClick={handleTranslateMode}
            disabled={Boolean(switching) || busy || translateBusy}
            title="AI字幕与收音翻译"
          >
            <Languages size={15} />
            <span>音频翻译</span>
          </button>
        </div>
        <div className="titlebar-right">
          {workspace === "translate" ? (
            <span className="status-dot ready"><span />翻译模式</span>
          ) : (
            <StatusDot status={engines.status} />
          )}
          {workspace === "tts" && (
            <button className="icon-btn" onClick={() => void refreshHistory()} title="刷新历史">
              <RefreshCw size={15} />
            </button>
          )}
        </div>
      </div>

      {engines.error && (
        <div className="banner warning"><AlertCircle size={16} /> {engines.error}</div>
      )}
      {error && (
        <div className="banner error">
          <AlertCircle size={16} /> {error}
          <button onClick={() => setError("")}>关闭</button>
        </div>
      )}
      {notice && <div className="toast"><CheckCircle2 size={16} /> {notice}</div>}

      <main className="layout">
        <section className="column config-column">
          <div className="panel">
            <div className="panel-head">
              <span className="step"><Mic size={16} /></span>
              <div>
                <h2>音色参考</h2>
                <p>5–15 秒干净人声，支持上传或录音</p>
              </div>
              <Tag tone={isDraftSelected ? "warn" : selectedVoice ? "good" : "warn"}>
                {isDraftSelected ? "待保存" : selectedVoice ? "已选择" : "未选择"}
              </Tag>
            </div>

            <div className="voice-actions">
              <label className={`upload-btn ${busy ? "disabled" : ""}`}>
                <Upload size={16} /> 上传音频
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleUpload(file);
                    event.target.value = "";
                  }}
                />
              </label>
              <button
                className={`record-btn ${recording ? "recording" : ""}`}
                onClick={() => (recording ? stopRecording() : void startRecording())}
                disabled={busy}
              >
                {recording ? <Square size={15} /> : <Mic size={16} />}
                {recording ? "停止录音" : "录音"}
              </button>
              <button className="ghost-btn" onClick={() => setVoicePickerOpen(true)}>
                <ListMusic size={15} /> 选择音频
              </button>
            </div>

            <AudioPicker
              title="音色参考音频"
              library={voicePickerLibrary}
              value={voiceId}
              open={voicePickerOpen}
              onOpenChange={setVoicePickerOpen}
              onChange={setVoiceId}
              onDelete={handleDeleteVoice}
              onSaveAs={openSaveAs}
              emptyText="请选择音色参考音频"
            />
          </div>

          <div className="panel text-panel">
            <div className="panel-head">
              <span className="step"><Languages size={16} /></span>
              <div>
                <h2>文本与语言</h2>
                <p>输入要合成的文本，选择目标语言</p>
              </div>
              <select
                className="lang-mini"
                value={lang}
                onChange={(event) => setLang(event.target.value)}
                title="目标语言"
              >
                {(activeEngine?.languages || ["zh"]).map((code) => (
                  <option key={code} value={code}>
                    {LANGUAGE_LABELS[code] || code}
                  </option>
                ))}
              </select>
            </div>

            <div className="text-area-wrap">
              <textarea
                className="text-input"
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={7}
                maxLength={5000}
                placeholder="请输入要合成的文本..."
              />
              <span className="char-count">{text.length} 字</span>
            </div>

            {activeEngine?.supportsDurationFactor && (
              <div className="duration-row">
                <span className="duration-label">时长系数</span>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.01}
                  value={durationFactor}
                  onChange={(event) => setDurationFactor(Number(event.target.value))}
                />
                <b className="duration-value">{durationFactor.toFixed(2)}x</b>
              </div>
            )}
          </div>

          <div className="panel emotion-panel">
            <div className="panel-head">
              <span className="step"><Smile size={16} /></span>
              <div>
                <h2>情感控制</h2>
                <p>{supportsEmotion ? "情绪与音色可以分开指定" : "极速版的情感由参考音频决定"}</p>
              </div>
              {supportsEmotion ? <Tag tone="good">完整支持</Tag> : <Tag tone="warn">仅参考音频</Tag>}
            </div>

            {!supportsEmotion ? (
              <div className="info-card">
                <Wand2 size={18} />
                <div>
                  <strong>极速版不提供独立情感输入</strong>
                  <p>
                    参考音频本身是什么情绪，生成结果就是什么情绪。需要 8 维情感、情感参考音频或文本情感，请切换到「完整版」。
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="emotion-tabs">
                  {activeEngine?.emotionModes.map((mode) => (
                    <button
                      key={mode}
                      className={emotionMode === mode ? "active" : ""}
                      onClick={() => setEmotionMode(mode)}
                    >
                      {EMOTION_LABELS[mode]}
                    </button>
                  ))}
                </div>

                {emotionMode === "reference" && (
                  <div className="info-card">
                    <Sparkles size={18} />
                    <div>
                      <strong>跟随音色参考音频</strong>
                      <p>默认模式。不额外指定情感，模型会尽量保留参考音频的音色和情绪。</p>
                    </div>
                  </div>
                )}

                {emotionMode === "audio" && (
                  <div className="emotion-body">
                    <div className="field emotion-audio-field">
                      <span>情感参考音频</span>
                      <AudioPicker
                        title="情感参考音频"
                        library={emotionLibrary}
                        value={emotionVoiceId}
                        open={emotionPickerOpen}
                        onOpenChange={setEmotionPickerOpen}
                        onChange={setEmotionVoiceId}
                        onDelete={handleDeleteVoice}
                        onSaveAs={openSaveAs}
                        emptyText="请选择情感参考音频"
                      />
                      </div>
                    <label className="field">
                      <span>情感强度 <b>{emoAlpha.toFixed(2)}</b></span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={emoAlpha}
                        onChange={(event) => setEmoAlpha(Number(event.target.value))}
                      />
                    </label>
                  </div>
                )}

                {emotionMode === "vector" && (
                  <div className="emotion-body">
                    <div className="vector-grid">
                      {VECTOR_LABELS.map((label, index) => (
                        <label key={label} className="vector-item">
                          <span>{label}<b>{emoVector[index].toFixed(2)}</b></span>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={emoVector[index]}
                            onChange={(event) => {
                              const next = [...emoVector];
                              next[index] = Number(event.target.value);
                              setEmoVector(next);
                            }}
                          />
                        </label>
                      ))}
                    </div>
                    <label className="field">
                      <span>情感强度 <b>{emoAlpha.toFixed(2)}</b></span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={emoAlpha}
                        onChange={(event) => setEmoAlpha(Number(event.target.value))}
                      />
                    </label>
                  </div>
                )}

                {emotionMode === "text" && (
                  <div className="emotion-body">
                    <label className="field">
                      <span>情感描述</span>
                      <input
                        className="text-field"
                        value={emoText}
                        onChange={(event) => setEmoText(event.target.value)}
                        placeholder="例如：委屈巴巴、危险在悄悄逼近"
                      />
                      <small className="hint">留空则自动用正文判断情绪；实验性功能，建议强度 0.6 左右</small>
                    </label>
                    <label className="field">
                      <span>情感强度 <b>{emoAlpha.toFixed(2)}</b></span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={emoAlpha}
                        onChange={(event) => setEmoAlpha(Number(event.target.value))}
                      />
                    </label>
                  </div>
                )}
              </>
            )}
          <button className="advanced-toggle" onClick={() => setShowAdvanced((value) => !value)}>
              <span><Settings2 size={16} /> 高级生成参数</span>
              <ChevronDown size={16} className={showAdvanced ? "rotated" : ""} />
            </button>
            {showAdvanced && (
              <div className="advanced-grid">
                <label className="field">
                  <span>temperature <b>{String(advanced.temperature ?? 0.8)}</b></span>
                  <input
                    type="range"
                    min={0.1}
                    max={2}
                    step={0.1}
                    value={Number(advanced.temperature ?? 0.8)}
                    onChange={(event) => updateAdvanced("temperature", Number(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span>top_p <b>{String(advanced.top_p ?? 0.8)}</b></span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={Number(advanced.top_p ?? 0.8)}
                    onChange={(event) => updateAdvanced("top_p", Number(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span>top_k <b>{String(advanced.top_k ?? 30)}</b></span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={Number(advanced.top_k ?? 30)}
                    onChange={(event) => updateAdvanced("top_k", Number(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span>num_beams <b>{String(advanced.num_beams ?? 1)}</b></span>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    step={1}
                    value={Number(advanced.num_beams ?? 1)}
                    onChange={(event) => updateAdvanced("num_beams", Number(event.target.value))}
                  />
                  <small className="hint">完整版下大于 1 会显著变慢，默认 1</small>
                </label>
                <label className="field">
                  <span>repetition_penalty <b>{String(advanced.repetition_penalty ?? 10)}</b></span>
                  <input
                    type="range"
                    min={0.1}
                    max={20}
                    step={0.1}
                    value={Number(advanced.repetition_penalty ?? 10)}
                    onChange={(event) => updateAdvanced("repetition_penalty", Number(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span>max_mel_tokens <b>{String(advanced.max_mel_tokens ?? 1500)}</b></span>
                  <input
                    type="range"
                    min={50}
                    max={1815}
                    step={10}
                    value={Number(advanced.max_mel_tokens ?? 1500)}
                    onChange={(event) => updateAdvanced("max_mel_tokens", Number(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span>分句最大 Token <b>{String(advanced.max_text_tokens_per_segment ?? 120)}</b></span>
                  <input
                    type="range"
                    min={20}
                    max={600}
                    step={2}
                    value={Number(advanced.max_text_tokens_per_segment ?? 120)}
                    onChange={(event) =>
                      updateAdvanced("max_text_tokens_per_segment", Number(event.target.value))
                    }
                  />
                </label>
              </div>
            )}
</div>

          <div className="panel generate-panel">
            <div className="preset-row">
              <select
                value={presetId}
                onChange={(event) => applyPreset(event.target.value)}
                className="preset-select"
              >
                <option value="">选择预设...</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.name}</option>
                ))}
              </select>
              <button className="ghost-btn" onClick={openPresetDialog}>
                <Save size={15} /> 保存预设
              </button>
            </div>

                        <button
              className="generate-btn"
              onClick={() => void handleGenerate()}
              disabled={busy || !isReady}
            >
              {busy ? <Loader2 className="spin" size={18} /> : <AudioLines size={18} />}
              {busy ? "正在生成..." : "生成语音"}
            </button>
            <p className="generate-hint">
              {activeEngine ? `${activeEngine.label} · ${activeEngine.speedHint}` : ""}
            </p>
          </div>
        </section>

        <aside className="column result-column">
          <div className="panel result-panel">
            <div className="panel-head">
              <span className="step"><AudioLines size={16} /></span>
              <div>
                <h2>生成结果</h2>
                <p>播放、下载或继续调整参数</p>
              </div>
              {job?.status === "succeeded" && <Tag tone="good">完成</Tag>}
            </div>

            {!job ? (
              <div className="empty-result">
                <div className="wave-placeholder">
                  {Array.from({ length: 20 }).map((_, index) => (
                    <span key={index} style={{ height: `${18 + ((index * 13) % 32)}px` }} />
                  ))}
                </div>
                <p>生成后，音频会出现在这里。</p>
              </div>
            ) : (
              <div className="result-body">
                <div className={`job-status ${job.status}`}>
                  {job.status === "queued" && <><Loader2 className="spin" size={16} /> 排队中</>}
                  {job.status === "running" && <><Loader2 className="spin" size={16} /> 正在合成</>}
                  {job.status === "succeeded" && <><CheckCircle2 size={16} /> 合成完成</>}
                  {job.status === "failed" && <><AlertCircle size={16} /> 合成失败</>}
                  {job.status === "canceled" && <><AlertCircle size={16} /> 已取消</>}
                  <span>{job.engine === "mlx" ? "极速版" : "完整版"}</span>
                </div>

                {audioSrc && (
                  <audio key={job.id} controls src={audioSrc} className="result-audio" />
                )}

                {job.error && <div className="error-box">{job.error}</div>}

                <div className="metrics">
                  <div><Gauge size={15} /><span>RTF</span><b>{job.rtf ?? "—"}</b></div>
                  <div><Clock3 size={15} /><span>耗时</span><b>{job.elapsed ? `${job.elapsed}s` : "—"}</b></div>
                  <div><AudioLines size={15} /><span>音频</span><b>{job.duration ? `${job.duration}s` : "—"}</b></div>
                </div>

                <div className="result-actions">
                  {audioSrc && (
                    <a className="download-btn" href={audioSrc} download={`indextts-${job.id}.wav`}>
                      <Download size={16} /> 下载 WAV
                    </a>
                  )}
                  {(job.status === "queued" || job.status === "running") && (
                    <button className="ghost-btn" onClick={() => void handleCancel()}>取消</button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="panel history-panel">
            <div className="panel-head">
              <span className="step"><History size={16} /></span>
              <div>
                <h2>历史记录</h2>
                <p>最近 50 条，本地保存</p>
              </div>
              <button
                className="tag warn history-clear"
                onClick={() => void handleClearHistory()}
                disabled={!history.length}
                type="button"
              >
                清除全部
              </button>
            </div>
            {history.length === 0 ? (
              <div className="empty-state small"><p>还没有生成记录。</p></div>
            ) : (
              <div className="history-list">
                {history.slice(0, 8).map((item) => (
                  <div
                    key={item.id}
                    className={`history-item ${job?.id === item.id ? "selected" : ""}`}
                  >
                    <button className="history-main" onClick={() => setJob(item)}>
                      <span className={`history-dot ${item.status}`} />
                      <span className="history-copy">
                        <strong>{item.text.slice(0, 34)}{item.text.length > 34 ? "…" : ""}</strong>
                        <small>
                          {item.engine === "mlx" ? "极速版" : "完整版"} · {item.voice_name} · {formatTime(item.created_at)}
                        </small>
                      </span>
                      {item.status === "succeeded" && <CheckCircle2 size={14} className="ok-icon" />}
                      {item.status === "failed" && <AlertCircle size={14} className="fail-icon" />}
                    </button>
                    {item.status === "succeeded" && item.audio_url && (
                      <a
                        className="icon-btn history-download"
                        href={api.outputAudioUrl(item.audio_url)}
                        download={`indextts-${item.id}.wav`}
                        title="下载 WAV"
                      >
                        <Download size={13} />
                      </a>
                    )}
                    {item.status !== "queued" && item.status !== "running" && (
                      <button
                        className="icon-btn history-delete"
                        onClick={() => void handleDeleteJob(item)}
                        title="删除这条记录"
                        type="button"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </main>

      {workspace === "translate" && (
        <TranslateWorkspace
          miniMode={miniMode}
          onMiniMode={handleMiniMode}
          onBusyChange={setTranslateBusy}
        />
      )}

      {saveAsSource && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-brand">
              <img className="modal-app-icon" src={appIcon} alt="" />
              <div className="modal-head">
                <h3>
                  {draftVoice && saveAsSource.id === draftVoice.id
                    ? "保存参考音频"
                    : "另存参考音频"}
                </h3>
                <p>
                  {draftVoice && saveAsSource.id === draftVoice.id
                    ? "这段音频还没有入库，选择保存到音色参考库或情感参考库"
                    : `源音频：${saveAsSource.name}`}
                </p>
              </div>
            </div>
            <label className="field">
              <span>新名称</span>
              <input
                className="text-field"
                value={saveAsName}
                onChange={(event) => setSaveAsName(event.target.value)}
                placeholder={saveAsSource.name}
                autoFocus
              />
              <small className="hint">不填写则沿用原名称</small>
            </label>
            <div className="modal-actions">
              <button
                className="ghost-btn"
                onClick={() => setSaveAsSource(null)}
                disabled={saveAsBusy}
              >
                取消
              </button>
              <button
                className="ghost-btn"
                onClick={() => void submitSaveAs("voice")}
                disabled={saveAsBusy}
              >
                保存为音色参考音频
              </button>
              <button
                className="generate-btn modal-primary"
                onClick={() => void submitSaveAs("emotion")}
                disabled={saveAsBusy}
              >
                {saveAsBusy ? <Loader2 className="spin" size={15} /> : null}
                保存为情感参考音频
              </button>
            </div>
          </div>
        </div>
      )}

      {presetDialogOpen && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-brand">
              <img className="modal-app-icon" src={appIcon} alt="" />
              <div className="modal-head">
                <h3>保存预设</h3>
                <p>保存当前音色、参数和情感设置</p>
              </div>
            </div>
            <label className="field">
              <span>预设名称</span>
              <input
                className="text-field"
                value={presetName}
                onChange={(event) => setPresetName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitPreset();
                }}
                placeholder="例如：温柔旁白"
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button
                className="ghost-btn"
                onClick={() => setPresetDialogOpen(false)}
                disabled={presetSaving}
              >
                取消
              </button>
              <button
                className="generate-btn modal-primary"
                onClick={() => void submitPreset()}
                disabled={presetSaving || !presetName.trim()}
              >
                {presetSaving ? <Loader2 className="spin" size={15} /> : null}
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmState && (
        <div className="modal-backdrop">
          <div className="modal confirm-modal">
            <div className="modal-brand">
              <img className="modal-app-icon" src={appIcon} alt="" />
              <div className="modal-head">
                <h3>{confirmState.title}</h3>
                <p>{confirmState.message}</p>
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="ghost-btn"
                onClick={() => setConfirmState(null)}
                disabled={confirmBusy}
              >
                取消
              </button>
              <button
                className={`generate-btn modal-primary ${confirmState.danger ? "danger" : ""}`}
                onClick={() => void executeConfirm()}
                disabled={confirmBusy}
              >
                {confirmBusy ? <Loader2 className="spin" size={15} /> : null}
                {confirmState.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}