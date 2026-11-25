import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Check,
  ChevronDown,
  MoreVertical,
  Pause,
  Play,
  Save,
  Trash2,
} from "lucide-react";
import * as api from "../api";
import type { Voice, VoiceKind } from "../types";

interface AudioPickerProps {
  title: string;
  library: Voice[];
  value: string;
  open: boolean;
  emptyText: string;
  onChange: (id: string) => void;
  onOpenChange: (open: boolean) => void;
  onDelete: (voice: Voice) => void;
  onSaveAs: (voice: Voice, kind: VoiceKind) => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

export default function AudioPicker({
  title,
  library,
  value,
  open,
  emptyText,
  onChange,
  onOpenChange,
  onDelete,
  onSaveAs,
}: AudioPickerProps) {
  const selected = library.find((voice) => voice.id === value) || null;
  const audioSource = selected
    ? selected.audioUrl?.startsWith("blob:")
      ? selected.audioUrl
      : api.voiceAudioUrl(selected.id)
    : undefined;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
    setMenuOpen(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, [value]);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !selected) return;
    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  }

  function openPicker() {
    setMenuOpen(false);
    onOpenChange(!open);
  }

  function openMenu() {
    onOpenChange(false);
    setMenuOpen(!menuOpen);
  }

  function choose(voice: Voice) {
    onChange(voice.id);
    onOpenChange(false);
  }

  return (
    <div className="picker-wrap">
      <div className="picker-card">
      <div className={`picker-selected ${selected ? "" : "empty"}`}>
        <button className="picker-trigger" onClick={openPicker} type="button">
          <span className="voice-icon"><AudioLines size={15} /></span>
          <span className="picker-copy">
            <strong>{selected ? selected.name : emptyText}</strong>
            <small>
              {selected
                ? `${selected.duration.toFixed(1)}s · ${selected.sampleRate}Hz`
                : "点击选择或先从左侧上传"}
            </small>
          </span>
          <ChevronDown size={15} className={open ? "rotated" : ""} />
        </button>
        {selected && (
          <button
            className="picker-more"
            onClick={openMenu}
            type="button"
            title="更多操作"
          >
            <MoreVertical size={15} />
          </button>
        )}
      </div>

      {selected && (
        <div className="mini-player">
          <button className="mini-play" onClick={togglePlay} type="button">
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <input
            className="mini-progress"
            type="range"
            min={0}
            max={duration || 0}
            step={0.01}
            value={Math.min(current, duration || 0)}
            onChange={(event) => {
              const next = Number(event.target.value);
              setCurrent(next);
              if (audioRef.current) audioRef.current.currentTime = next;
            }}
          />
          <span className="mini-time">{formatTime(current)} / {formatTime(duration)}</span>
          <audio
            ref={audioRef}
            src={audioSource}
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
          />
        </div>
      )}
      </div>

      {open && (
        <>
          <div className="popover-backdrop" onClick={() => onOpenChange(false)} />
          <div className="picker-popover">
            <div className="popover-head">
              <strong>{title}</strong>
              <span>{library.length} 个音频</span>
            </div>
            <div className="picker-list">
              {library.length === 0 ? (
                <div className="picker-empty">还没有音频，可先在音色参考中上传并保存。</div>
              ) : (
                library.map((voice) => (
                  <button
                    key={voice.id}
                    className={`picker-item ${voice.id === value ? "selected" : ""}`}
                    onClick={() => choose(voice)}
                    type="button"
                  >
                    <span className="voice-icon"><AudioLines size={14} /></span>
                    <span className="picker-item-copy">
                      <strong>{voice.name}</strong>
                      <small>{voice.duration.toFixed(1)}s · {voice.sampleRate}Hz</small>
                    </span>
                    {voice.id === value && <Check size={14} className="ok-icon" />}
                  </button>
                ))
              )}
            </div>
            </div>
        </>
      )}

      {menuOpen && selected && (
        <>
          <div className="popover-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="menu-popover">
            <button onClick={togglePlay} type="button">
              {playing ? <Pause size={14} /> : <Play size={14} />}
              {playing ? "暂停试听" : "播放试听"}
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                onSaveAs(selected, "voice");
              }}
              type="button"
            >
              <Save size={14} /> 保存为音色参考音频
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                onSaveAs(selected, "emotion");
              }}
              type="button"
            >
              <Save size={14} /> 保存为情感参考音频
            </button>
            <button
              className="danger"
              onClick={() => {
                setMenuOpen(false);
                onDelete(selected);
              }}
              type="button"
            >
              <Trash2 size={14} /> 从库中删除
            </button>
          </div>
        </>
      )}
    </div>
  );
}