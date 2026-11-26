import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  AudioLines,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  Gauge,
  Languages,
  Loader2,
  Mic,
  Minimize2,
  Monitor,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Upload,
  Maximize2,
} from "lucide-react";

import * as api from "../api";
import type { SubtitleCue, SubtitleJob, TranslateStatus } from "../types";
import { useAudioTranslation, type AudioSource } from "../hooks/useAudioTranslation";
import "../translate.css";

const TARGETS = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "pt", label: "Português" },
  { value: "ru", label: "Русский" },
  { value: "it", label: "Italiano" },
];

const STEPS = ["选择视频", "提取音频", "识别与对齐", "翻译", "生成字幕"];

function formatCueTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  const tenths = Math.floor((total % 1) * 10);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function isBusy(job: SubtitleJob | null): boolean {
  return Boolean(job && ["uploading", "queued", "running"].includes(job.status));
}

function Waveform({
  analyser,
  listening,
}: {
  analyser: AnalyserNode | null;
  listening: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;
    let cancelled = false;
    const data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;

    const draw = () => {
      if (cancelled) return;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#18b884";
      const bars = 64;
      const gap = 3;
      const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);
      if (analyser && data && listening) {
        analyser.getByteFrequencyData(data);
        const step = Math.max(1, Math.floor(data.length / bars));
        for (let index = 0; index < bars; index += 1) {
          const value = data[index * step] / 255;
          const barHeight = Math.max(3, value * (height - 20));
          const x = index * (barWidth + gap);
          const y = (height - barHeight) / 2;
          context.globalAlpha = 0.35 + value * 0.65;
          context.beginPath();
          context.roundRect(x, y, barWidth, barHeight, barWidth / 2);
          context.fill();
        }
      } else {
        context.globalAlpha = 0.22;
        for (let index = 0; index < bars; index += 1) {
          const barHeight = 4 + ((index * 7) % 14);
          const x = index * (barWidth + gap);
          context.beginPath();
          context.roundRect(x, (height - barHeight) / 2, barWidth, barHeight, barWidth / 2);
          context.fill();
        }
      }
      context.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [analyser, listening]);

  return <canvas ref={canvasRef} className="waveform-canvas" />;
}

function CueRow({ cue, index }: { cue: SubtitleCue; index: number }) {
  return (
    <div className="cue-row">
      <div className="cue-time">
        <b>{String(index + 1).padStart(2, "0")}</b>
        <span>{formatCueTime(cue.start)} → {formatCueTime(cue.end)}</span>
      </div>
      <div className="cue-copy">
        <p>{cue.translation || "—"}</p>
        <small>{cue.source}</small>
        <div className="cue-tags">
          {cue.timestamps === "aligner" ? <em>词级时间轴</em> : <em>静音切段</em>}
          {cue.refusal && <em className="warn">需复核</em>}
        </div>
      </div>
    </div>
  );
}

export default function TranslateWorkspace({
  miniMode,
  onMiniMode,
  onBusyChange,
}: {
  miniMode: boolean;
  onMiniMode: (enabled: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [mode, setMode] = useState<"subtitle" | "interpret">("subtitle");
  const [status, setStatus] = useState<TranslateStatus | null>(null);
  const [activating, setActivating] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [target, setTarget] = useState("zh");
  const [silence, setSilence] = useState(0.4);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [job, setJob] = useState<SubtitleJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [interpretTarget, setInterpretTarget] = useState("zh");
  const [interpretSilence, setInterpretSilence] = useState(1.5);
  const [audioSource, setAudioSource] = useState<AudioSource>("mic");
  const mic = useAudioTranslation(interpretTarget, interpretSilence, audioSource);

  async function ensureReady() {
    setActivating(true);
    setError("");
    try {
      const next = await api.getTranslateStatus();
      if (!next.ready && next.missing.length) {
        setStatus(next);
        setError("翻译模型未安装，请先运行 npm run translate:setup");
        return;
      }
      setStatus(next.ready ? next : await api.activateTranslate());
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setActivating(false);
    }
  }

  useEffect(() => {
    void ensureReady();
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const ready = Boolean(status?.ready) && !activating;
  const subtitleBusy = submitting || isBusy(job);
  const progress = job?.progress ?? 0;
  const currentStep = job?.step ?? 0;

  useEffect(() => {
    onBusyChange?.(subtitleBusy);
    return () => onBusyChange?.(false);
  }, [onBusyChange, subtitleBusy]);

  async function handleGenerate() {
    if (!ready) {
      setError("翻译模型尚未就绪");
      return;
    }
    if (!videoFile) {
      setError("请先选择视频文件");
      return;
    }
    setSubmitting(true);
    setError("");
    setJob(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const created = await api.createSubtitleJob(videoFile, {
        source: "auto",
        target,
        silence,
        batchSize: 5,
      });
      if (controller.signal.aborted) return;
      setJob(created);
      await api.streamSubtitleJob(created.id, setJob, controller.signal);
    } catch (exc) {
      if (!controller.signal.aborted) {
        setError(exc instanceof Error ? exc.message : String(exc));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!job) return;
    try {
      setJob(await api.cancelSubtitleJob(job.id));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  }

  async function copyLines() {
    const text = mic.lines
      .filter((line) => line.status === "done")
      .map((line) => line.translation)
      .join("\n");
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setNotice("译文已复制");
  }

  const latestLine =
    [...mic.lines].reverse().find((line) => line.status === "done") ||
    mic.lines[mic.lines.length - 1];

  if (miniMode) {
    return (
      <div className="mini-bar">
        <button
          className={`mini-action ${mic.listening ? "active" : ""}`}
          onClick={() => (mic.listening ? mic.stop() : void mic.start())}
          disabled={!ready}
          title={mic.listening ? "结束收音" : "开始收音"}
          type="button"
        >
          {mic.listening ? <Square size={16} /> : <Play size={16} />}
        </button>
        <button
          className="mini-action"
          onClick={() => onMiniMode(false)}
          title="恢复正常界面"
          type="button"
        >
          <Maximize2 size={16} />
        </button>
        <div className="mini-text">
          {latestLine?.translation ||
            (mic.listening ? "正在监听…" : ready ? "等待开始" : "翻译模型加载中…")}
        </div>
      </div>
    );
  }

  return (
    <div className="translate-shell">
      {error && (
        <div className="banner error translate-banner">
          <AlertCircle size={16} /> {error}
          <button onClick={() => setError("")}>关闭</button>
        </div>
      )}
      {notice && <div className="toast"><CheckCircle2 size={16} /> {notice}</div>}

      <div className="translate-grid">
        <aside className="translate-left">
          <section
            className={`panel mode-card ${mode === "subtitle" ? "active" : ""}`}
            onClick={() => setMode("subtitle")}
          >
            <div className="panel-head">
              <span className="step"><Languages size={16} /></span>
              <div>
                <h2>AI 字幕</h2>
                <p>视频转写、翻译并导出字幕</p>
              </div>
              <div className="lang-pair">
                <span>自动</span>
                <b>→</b>
                <select
                  className="lang-mini"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                >
                  {TARGETS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mode-body">
              <label className={`upload-btn ${subtitleBusy ? "disabled" : ""}`}>
                <Upload size={16} /> 选择视频
                <input
                  type="file"
                  accept="video/*"
                  disabled={subtitleBusy}
                  onChange={(event) => {
                    const file = event.target.files?.[0] || null;
                    setVideoFile(file);
                    event.target.value = "";
                  }}
                />
              </label>
              <div className={`file-row ${videoFile ? "has-file" : ""}`}>
                <AudioLines size={15} />
                <span>{videoFile ? videoFile.name : "尚未选择视频"}</span>
                {videoFile && <small>{formatSize(videoFile.size)}</small>}
              </div>

              <label className="field compact">
                <span>静音断句 <b>{silence.toFixed(1)}s</b></span>
                <input
                  type="range"
                  min={0.2}
                  max={3}
                  step={0.1}
                  value={silence}
                  onChange={(event) => setSilence(Number(event.target.value))}
                />
              </label>

              <button
                className="generate-btn"
                onClick={() => void handleGenerate()}
                disabled={!ready || !videoFile || subtitleBusy}
              >
                {subtitleBusy ? <Loader2 className="spin" size={18} /> : <AudioLines size={18} />}
                {submitting && !job ? "正在上传视频…" : subtitleBusy ? "正在生成字幕…" : "生成字幕"}
              </button>
            </div>
          </section>

          <section
            className={`panel mode-card ${mode === "interpret" ? "active" : ""}`}
            onClick={() => setMode("interpret")}
          >
            <div className="panel-head">
              <span className="step"><Mic size={16} /></span>
              <div>
                <h2>收音翻译</h2>
                <p>静音断句后逐句识别并翻译</p>
              </div>
              <div className="lang-pair">
                <span>自动</span>
                <b>→</b>
                <select
                  className="lang-mini"
                  value={interpretTarget}
                  onChange={(event) => setInterpretTarget(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                >
                  {TARGETS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mode-body mic-body">
              <div className="source-switch" onClick={(event) => event.stopPropagation()}>
                <button
                  className={audioSource === "mic" ? "active" : ""}
                  onClick={() => setAudioSource("mic")}
                  disabled={mic.listening}
                  type="button"
                >
                  <Mic size={14} /> 麦克风
                </button>
                <button
                  className={audioSource === "system" ? "active" : ""}
                  onClick={() => setAudioSource("system")}
                  disabled={mic.listening}
                  type="button"
                >
                  <Monitor size={14} /> 系统音频
                </button>
              </div>

              <button
                className={`mic-orb ${mic.listening ? "recording" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  mic.listening ? mic.stop() : void mic.start();
                }}
                disabled={!ready}
              >
                {mic.listening ? (
                  <Square size={26} />
                ) : audioSource === "system" ? (
                  <Monitor size={28} />
                ) : (
                  <Mic size={28} />
                )}
                <span>
                  {mic.listening
                    ? "停止收听"
                    : audioSource === "system"
                      ? "开始监听"
                      : "开始收音"}
                </span>
              </button>

              <label className="field compact" onClick={(event) => event.stopPropagation()}>
                <span>静音间隔 <b>{interpretSilence.toFixed(1)}s</b></span>
                <input
                  type="range"
                  min={0.5}
                  max={5}
                  step={0.1}
                  value={interpretSilence}
                  onChange={(event) => setInterpretSilence(Number(event.target.value))}
                />
              </label>
              {mic.error && <div className="inline-error">{mic.error}</div>}
            </div>
          </section>
        </aside>

        <section className="translate-right">
          {mode === "subtitle" ? (
            <>
              <div className="panel progress-panel">
                <div className="panel-head">
                  <span className="step"><Gauge size={16} /></span>
                  <div>
                    <h2>生成成果</h2>
                    <p>{job?.message || (activating ? "正在加载翻译模型..." : "选择视频后开始生成")}</p>
                  </div>
                  {status && !status.ready && !activating && (
                    <button className="ghost-btn" onClick={() => void ensureReady()}>
                      <RefreshCw size={14} /> 重试
                    </button>
                  )}
                  {job?.status === "succeeded" && <span className="tag good">完成</span>}
                </div>

                <div className="stepper">
                  {STEPS.map((label, index) => {
                    const state = currentStep > index + 1 ? "done" : currentStep === index + 1 ? "active" : "";
                    return (
                      <div key={label} className={`step-item ${state}`}>
                        <span className="step-dot">{state === "done" ? <CheckCircle2 size={13} /> : index + 1}</span>
                        <b>{label}</b>
                      </div>
                    );
                  })}
                </div>

                <div className="progress-track">
                  <span style={{ width: `${Math.max(progress, job ? 3 : 0)}%` }} />
                </div>

                <div className="metrics">
                  <div><Gauge size={15} /><span>RTF</span><b>{job?.rtf ?? "—"}</b></div>
                  <div><Clock3 size={15} /><span>耗时</span><b>{job?.elapsed ? `${job.elapsed}s` : "—"}</b></div>
                  <div><AudioLines size={15} /><span>音频</span><b>{job?.duration ? `${job.duration}s` : "—"}</b></div>
                  <div><Languages size={15} /><span>字幕</span><b>{job?.cue_count ?? 0} 条</b></div>
                </div>

                {job?.timings && job.timings.total > 0 && (
                  <div className="timing-breakdown">
                    识别 <b>{job.timings.asr.toFixed(1)}s</b>
                    <span> · </span>
                    对齐 <b>{(job.timings.align || 0).toFixed(1)}s</b>
                    <span> · </span>
                    翻译 <b>{(job.timings.translate || 0).toFixed(1)}s</b>
                    <span> · </span>
                    过滤 <b>{job.filtered || 0}</b> 条
                  </div>
                )}

                <div className="result-actions">
                  {job?.status === "succeeded" && (
                    <>
                      <a className="download-btn" href={api.subtitleDownloadUrl(job.id, "srt")} download={`${job.video_name}.srt`}>
                        <Download size={16} /> 下载 SRT
                      </a>
                      <a className="ghost-btn" href={api.subtitleDownloadUrl(job.id, "vtt")} download={`${job.video_name}.vtt`}>
                        <Download size={16} /> VTT
                      </a>
                    </>
                  )}
                  {isBusy(job) && (
                    <button className="ghost-btn" onClick={() => void handleCancel()}>取消</button>
                  )}
                </div>
                {job?.error && <div className="error-box">{job.error}</div>}
              </div>

              <div className="panel preview-panel">
                <div className="panel-head">
                  <span className="step"><AudioLines size={16} /></span>
                  <div>
                    <h2>字幕预览</h2>
                    <p>时间轴与翻译后的文本</p>
                  </div>
                  <span className="tag neutral">{job?.cue_count ?? 0} 条</span>
                </div>
                <div className="subtitle-list">
                  {job?.cues?.length ? (
                    job.cues.map((cue, index) => (
                      <CueRow key={`${cue.start}-${index}`} cue={cue} index={index} />
                    ))
                  ) : (
                    <div className="empty-state small">
                      <p>{job ? "字幕生成后会显示在这里。" : "选择视频并生成字幕后显示。"}</p>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="panel interpret-panel">
              <div className="panel-head">
                <span className="step"><Mic size={16} /></span>
                <div>
                  <h2>实时译文</h2>
                  <p>
                    {mic.listening
                      ? audioSource === "system"
                        ? "正在监听系统音频，停顿后自动翻译"
                        : "正在收音，停顿后自动翻译"
                      : audioSource === "system"
                        ? "点击左侧按钮选择要监听的屏幕声音"
                        : "点击左侧麦克风开始"}
                  </p>
                </div>
                <div className="interpret-actions">
                  <button
                    className="icon-btn"
                    onClick={() => onMiniMode(true)}
                    title="迷你模式"
                    type="button"
                  >
                    <Minimize2 size={15} />
                  </button>
                  <button className="ghost-btn" onClick={() => void copyLines()} disabled={!mic.lines.length}>
                    <Copy size={15} /> 复制内容
                  </button>
                  <button className="ghost-btn" onClick={mic.clear} disabled={!mic.lines.length}>
                    <Trash2 size={15} /> 清除内容
                  </button>
                </div>
              </div>

              <div className={`waveform-wrap ${mic.listening ? "live" : ""}`}>
                <Waveform analyser={mic.analyser} listening={mic.listening} />
                <div className="waveform-label">
                  {mic.listening ? <><span className="live-dot" /> 正在监听</> : "等待开始"}
                </div>
              </div>

              <div className="transcript-list">
                {mic.lines.length ? (
                  mic.lines.map((line) => (
                    <div key={line.id} className={`transcript-line ${line.status}`}>
                      <span className="transcript-time">{line.time}</span>
                      <div>
                        <p>{line.translation}</p>
                        {line.source && <small>{line.source}</small>}
                      </div>
                      {line.status === "pending" && <Loader2 className="spin" size={15} />}
                      {line.status === "done" && <CheckCircle2 size={15} className="ok-icon" />}
                      {line.status === "error" && <AlertCircle size={15} className="fail-icon" />}
                    </div>
                  ))
                ) : (
                  <div className="empty-state small">
                    <p>开始收音后，翻译内容会逐行显示。</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}