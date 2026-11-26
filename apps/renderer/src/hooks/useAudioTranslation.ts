import { useEffect, useRef, useState } from "react";

import * as api from "../api";

export type AudioSource = "mic" | "system";

export interface InterpretLine {
  id: string;
  time: string;
  source: string;
  translation: string;
  status: "pending" | "done" | "error";
}

function downsample(input: Float32Array, inputRate: number, outputRate = 16000): Float32Array {
  if (outputRate === inputRate) return input;
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    output[index] = input[Math.floor(index * ratio)] ?? 0;
  }
  return output;
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function mergeChunks(chunks: Float32Array[], length: number): Float32Array {
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function useAudioTranslation(
  target: string,
  silenceSeconds: number,
  source: AudioSource,
) {
  const [listening, setListening] = useState(false);
  const [lines, setLines] = useState<InterpretLine[]>([]);
  const [error, setError] = useState("");
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const speechRef = useRef(false);
  const lastVoiceRef = useRef(0);
  const chunksRef = useRef<Float32Array[]>([]);
  const preRollRef = useRef<Float32Array[]>([]);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const targetRef = useRef(target);
  const silenceRef = useRef(silenceSeconds);
  const sourceTypeRef = useRef(source);
  const stoppingRef = useRef(false);
  const startedAtRef = useRef(0);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  useEffect(() => {
    silenceRef.current = silenceSeconds;
  }, [silenceSeconds]);

  useEffect(() => {
    sourceTypeRef.current = source;
  }, [source]);

  function timestamp(): string {
    const elapsed = Math.max(0, Date.now() - startedAtRef.current);
    const seconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function finalizeUtterance(context: AudioContext) {
    const chunks = chunksRef.current;
    chunksRef.current = [];
    speechRef.current = false;
    lastVoiceRef.current = 0;
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!totalLength || totalLength < context.sampleRate * 0.25) {
      return;
    }
    const merged = mergeChunks(chunks, totalLength);
    const samples = downsample(merged, context.sampleRate);
    const blob = new Blob([encodeWav(samples, 16000)], { type: "audio/wav" });
    const id = crypto.randomUUID();
    const lineTime = timestamp();
    setLines((current) => [
      ...current,
      {
        id,
        time: lineTime,
        source: "",
        translation: "正在识别…",
        status: "pending",
      },
    ]);
    queueRef.current = queueRef.current.then(async () => {
      try {
        const result = await api.translateUtterance(blob, targetRef.current);
        setLines((current) =>
          current.map((line) =>
            line.id === id
              ? {
                  ...line,
                  source: result.source,
                  translation: result.translation || "（空）",
                  status: "done",
                }
              : line,
          ),
        );
      } catch (exc) {
        setLines((current) =>
          current.map((line) =>
            line.id === id
              ? {
                  ...line,
                  translation: exc instanceof Error ? exc.message : String(exc),
                  status: "error",
                }
              : line,
          ),
        );
      }
    });
  }

  async function start() {
    if (listening) return;
    setError("");
    stoppingRef.current = false;
    try {
      let stream: MediaStream;
      if (sourceTypeRef.current === "system") {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "monitor" },
          audio: true,
        });
        if (!stream.getAudioTracks().length) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error("没有捕获到系统音频，请确认共享时包含系统声音");
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }

      const audioTrack = stream.getAudioTracks()[0];
      audioTrack.addEventListener(
        "ended",
        () => {
          if (stoppingRef.current) return;
          setError("音频采集已停止，请重新开始");
          stop();
        },
        { once: true },
      );

      const context = new AudioContext({ latencyHint: "interactive" });
      await context.resume();
      const sourceNode = context.createMediaStreamSource(stream);
      const analyserNode = context.createAnalyser();
      analyserNode.fftSize = 1024;
      sourceNode.connect(analyserNode);

      const processor = context.createScriptProcessor(4096, 1, 1);
      const gain = context.createGain();
      gain.gain.value = 0;
      sourceNode.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);

      streamRef.current = stream;
      contextRef.current = context;
      sourceRef.current = sourceNode;
      processorRef.current = processor;
      gainRef.current = gain;
      preRollRef.current = [];
      chunksRef.current = [];
      speechRef.current = false;
      lastVoiceRef.current = 0;
      startedAtRef.current = Date.now();
      setAnalyser(analyserNode);

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer;
        const channelCount = input.numberOfChannels;
        const left = input.getChannelData(0);
        const chunk = new Float32Array(left.length);
        if (channelCount > 1) {
          const right = input.getChannelData(1);
          for (let index = 0; index < chunk.length; index += 1) {
            chunk[index] = (left[index] + right[index]) * 0.5;
          }
        } else {
          chunk.set(left);
        }

        let energy = 0;
        for (let index = 0; index < chunk.length; index += 1) {
          energy += chunk[index] * chunk[index];
        }
        const rms = Math.sqrt(energy / chunk.length);
        const threshold = sourceTypeRef.current === "system" ? 0.018 : 0.012;

        if (!speechRef.current) {
          preRollRef.current.push(chunk);
          if (preRollRef.current.length > 6) preRollRef.current.shift();
        }

        if (rms > threshold) {
          if (!speechRef.current) {
            speechRef.current = true;
            chunksRef.current = [...preRollRef.current, chunk];
            preRollRef.current = [];
          } else {
            chunksRef.current.push(chunk);
          }
          lastVoiceRef.current = performance.now();
          return;
        }

        if (!speechRef.current) return;
        chunksRef.current.push(chunk);
        if (performance.now() - lastVoiceRef.current >= silenceRef.current * 1000) {
          finalizeUtterance(context);
        }
      };

      setListening(true);
    } catch (exc) {
      setError(
        sourceTypeRef.current === "system"
          ? "系统音频启动失败：请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许 IndexTTS Studio / Electron，然后重启应用。"
          : exc instanceof Error
            ? exc.message
            : String(exc),
      );
    }
  }

  function stop() {
    stoppingRef.current = true;
    const context = contextRef.current;
    if (context && speechRef.current) {
      finalizeUtterance(context);
    }
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    gainRef.current?.disconnect();
    gainRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
    setAnalyser(null);
    setListening(false);
  }

  useEffect(() => {
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    listening,
    lines,
    error,
    analyser,
    start,
    stop,
    clear: () => setLines([]),
  };
}