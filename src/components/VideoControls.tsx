import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowsOut,
  CaretLeft,
  CaretRight,
  FastForward,
  Pause,
  Play,
  Repeat,
  Rewind,
  SpeakerHigh,
  SpeakerSlash
} from '@phosphor-icons/react'
import { bridge } from '@/lib/bridge'
import { fullUrl } from '@shared/protocol'
import { formatDuration } from '@/lib/format'
import { IconButton } from './ui'

/**
 * The clip player: OpenPics chrome around the browser's decoder.
 *
 * The `<video>` element stays dumb - it decodes and paints - while everything
 * the person touches lives here: play, seek with a hover preview, frame
 * stepping, speed, volume, loop and fullscreen. Browser-native controls are
 * off, because two control bars (ours and Chromium's) would fight over the
 * same clicks and neither would own keyboard focus properly.
 *
 * Frame stepping needs the frame rate, which the grid does not carry. It is
 * probed once per clip through the same ffprobe path the viewer already uses
 * for measuring clips on open, and 30fps stands in when the probe fails - a
 * step that lands a frame early still moves, which beats refusing to move.
 */
const SPEEDS = [0.5, 1, 1.25, 1.5, 2]
const FALLBACK_FPS = 30

export function VideoControls({ videoRef, path }: { videoRef: React.RefObject<HTMLVideoElement | null>; path: string }) {
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(true)
  const [rate, setRate] = useState(1)
  const [loop, setLoop] = useState(false)
  const [fps, setFps] = useState(FALLBACK_FPS)
  const [preview, setPreview] = useState<{ at: number; left: number } | null>(null)

  const previewVideoRef = useRef<HTMLVideoElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const seekRaf = useRef(0)

  // The element remounts per clip (keyed by path), so one subscription per
  // mount covers exactly one clip and never leaks listeners across them.
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const sync = (): void => {
      setPlaying(!el.paused && !el.ended)
      setTime(el.currentTime)
      if (Number.isFinite(el.duration)) setDuration(el.duration)
      setVolume(el.volume)
      setMuted(el.muted)
      setRate(el.playbackRate)
      setLoop(el.loop)
      if (el.buffered.length > 0) {
        try {
          setBuffered(el.buffered.end(el.buffered.length - 1))
        } catch {
          /* a range that vanished mid-read is not worth crashing over */
        }
      }
    }
    const events = ['play', 'pause', 'timeupdate', 'durationchange', 'volumechange', 'ratechange', 'ended', 'progress', 'seeked'] as const
    for (const name of events) el.addEventListener(name, sync)
    sync()
    return () => {
      for (const name of events) el.removeEventListener(name, sync)
    }
  }, [videoRef, path])

  // Frame rate, probed once per clip. Falls back to 30fps: stepping still
  // moves, just not exactly one frame.
  useEffect(() => {
    let live = true
    setFps(FALLBACK_FPS)
    void bridge.video
      .probe(path)
      .then((info) => {
        if (live && info.frameRate && info.frameRate > 0) setFps(info.frameRate)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [path])

  const togglePlay = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (el.paused || el.ended) void el.play().catch(() => {})
    else el.pause()
  }, [videoRef])

  const seekBy = useCallback(
    (delta: number) => {
      const el = videoRef.current
      if (!el || !Number.isFinite(el.duration)) return
      el.currentTime = Math.min(Math.max(0, el.currentTime + delta), el.duration)
    },
    [videoRef]
  )

  const stepFrame = useCallback(
    (direction: -1 | 1) => {
      const el = videoRef.current
      if (!el) return
      el.pause()
      seekBy(direction / fps)
    },
    [videoRef, seekBy, fps]
  )

  // K plays, J/L jump ten seconds, comma and period step a frame. Space stays
  // the slideshow's, so the two never fight over one key.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable
      ) {
        return
      }
      switch (event.key.toLowerCase()) {
        case 'k':
          event.preventDefault()
          togglePlay()
          break
        case 'j':
          event.preventDefault()
          seekBy(-10)
          break
        case 'l':
          event.preventDefault()
          seekBy(10)
          break
        case ',':
          event.preventDefault()
          stepFrame(-1)
          break
        case '.':
          event.preventDefault()
          stepFrame(1)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, seekBy, stepFrame])

  const fullscreen = useCallback(() => {
    const stage = videoRef.current?.closest('[data-viewer-stage]') as HTMLElement | null
    if (!stage) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void stage.requestFullscreen().catch(() => {})
  }, [videoRef])

  // Hover preview: a second, silent element seeks where the pointer is and
  // paints one frame to a small canvas. The main element is never touched, so
  // hovering the timeline cannot disturb playback. Seeks are throttled to one
  // animation frame - a fast scrub produces dozens of pointermoves per second
  // and ffprobe-free in-memory seeks are cheap but not free.
  const showPreview = useCallback(
    (clientX: number, bar: HTMLDivElement): void => {
      if (!Number.isFinite(duration) || duration <= 0) return
      const rect = bar.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const at = ratio * duration
      setPreview({ at, left: ratio * rect.width })
      const previewEl = previewVideoRef.current
      if (!previewEl) return
      cancelAnimationFrame(seekRaf.current)
      seekRaf.current = requestAnimationFrame(() => {
        if (Math.abs(previewEl.currentTime - at) > 0.25) {
          try {
            previewEl.currentTime = at
          } catch {
            /* a seek mid-load rejects; the next move retries */
          }
        } else {
          paintPreview()
        }
      })
    },
    [duration]
  )

  const paintPreview = useCallback(() => {
    const previewEl = previewVideoRef.current
    const canvas = previewCanvasRef.current
    if (!previewEl || !canvas || previewEl.readyState < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const scale = Math.min(1, 160 / previewEl.videoWidth || 1)
    canvas.width = Math.max(2, Math.round(previewEl.videoWidth * scale))
    canvas.height = Math.max(2, Math.round(previewEl.videoHeight * scale))
    try {
      ctx.drawImage(previewEl, 0, 0, canvas.width, canvas.height)
    } catch {
      /* a frame that is not decodable yet paints on the next seek */
    }
  }, [])

  useEffect(() => () => cancelAnimationFrame(seekRaf.current), [])

  const bufferedShare = duration > 0 ? Math.min(1, buffered / duration) : 0
  const playedShare = duration > 0 ? Math.min(1, time / duration) : 0

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-8"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {preview ? (
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 overflow-hidden rounded-[6px] border border-line bg-black"
          style={{ left: `calc(${preview.left}px + 12px)` }}
        >
          <canvas ref={previewCanvasRef} width={160} height={90} className="block h-[90px] w-[160px]" />
          <p className="num px-1.5 py-0.5 text-center text-[11px] text-ink-2">{formatDuration(preview.at)}</p>
        </div>
      ) : null}
      <div
        className="group relative flex h-5 cursor-pointer items-center"
        onPointerMove={(event) => showPreview(event.clientX, event.currentTarget)}
        onPointerLeave={() => {
          cancelAnimationFrame(seekRaf.current)
          setPreview(null)
        }}
        onPointerDown={(event) => {
          // Click-to-seek on the bar itself; dragging continues through move.
          const bar = event.currentTarget
          const rect = bar.getBoundingClientRect()
          const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
          const el = videoRef.current
          if (el && Number.isFinite(el.duration)) el.currentTime = ratio * el.duration
        }}
      >
        <div aria-hidden className="relative h-1 w-full overflow-hidden rounded-full bg-white/20">
          <div className="absolute inset-y-0 left-0 rounded-full bg-white/30" style={{ width: `${bufferedShare * 100}%` }} />
          <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${playedShare * 100}%` }} />
        </div>
        <div
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${formatDuration(time)} of ${formatDuration(duration)}`}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              seekBy(event.shiftKey ? -10 : -5)
            } else if (event.key === 'ArrowRight') {
              event.preventDefault()
              seekBy(event.shiftKey ? 10 : 5)
            } else if (event.key === 'Home') {
              event.preventDefault()
              const el = videoRef.current
              if (el) el.currentTime = 0
            } else if (event.key === 'End') {
              event.preventDefault()
              const el = videoRef.current
              if (el && Number.isFinite(el.duration)) el.currentTime = el.duration
            }
          }}
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          style={{ left: `${playedShare * 100}%` }}
        />
      </div>
      <div className="flex items-center gap-1">
        <IconButton label={playing ? 'Pause (K)' : 'Play (K)'} onClick={togglePlay}>
          {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
        </IconButton>
        <IconButton label="Back 10 seconds (J)" onClick={() => seekBy(-10)}>
          <Rewind size={14} weight="regular" />
        </IconButton>
        <IconButton label="Forward 10 seconds (L)" onClick={() => seekBy(10)}>
          <FastForward size={14} weight="regular" />
        </IconButton>
        <IconButton label="Previous frame (,)" onClick={() => stepFrame(-1)}>
          <CaretLeft size={14} weight="bold" />
        </IconButton>
        <IconButton label="Next frame (.)" onClick={() => stepFrame(1)}>
          <CaretRight size={14} weight="bold" />
        </IconButton>
        <span className="num px-1 text-[11px] text-ink-2">
          {formatDuration(time) || '0:00'} / {formatDuration(duration) || '–:––'}
        </span>
        <span className="flex-1" />
        <label className="flex items-center gap-1 text-[11px] text-ink-2">
          <span className="sr-only">Playback speed</span>
          <select
            value={rate}
            onChange={(event) => {
              const el = videoRef.current
              if (el) el.playbackRate = Number(event.target.value)
            }}
            aria-label="Playback speed"
            className="rounded-[4px] border border-line bg-transparent px-1 py-0.5 text-[11px] text-ink-2 focus:border-line-strong focus:outline-none"
          >
            {SPEEDS.map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
          </select>
        </label>
        <IconButton
          label={loop ? 'Looping on' : 'Loop off'}
          onClick={() => {
            const el = videoRef.current
            if (el) el.loop = !el.loop
          }}
        >
          <Repeat size={14} weight={loop ? 'fill' : 'regular'} className={loop ? 'text-accent-text' : undefined} />
        </IconButton>
        <IconButton
          label={muted || volume === 0 ? 'Unmute' : 'Mute'}
          onClick={() => {
            const el = videoRef.current
            if (el) el.muted = !el.muted
          }}
        >
          {muted || volume === 0 ? <SpeakerSlash size={14} weight="regular" /> : <SpeakerHigh size={14} weight="regular" />}
        </IconButton>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(event) => {
            const el = videoRef.current
            if (!el) return
            const next = Number(event.target.value)
            el.volume = next
            el.muted = next === 0
          }}
          aria-label="Volume"
          className="w-16"
        />
        <IconButton label="Fullscreen" onClick={fullscreen}>
          <ArrowsOut size={14} weight="regular" />
        </IconButton>
      </div>
      <video ref={previewVideoRef} src={fullUrl(path)} muted preload="auto" playsInline aria-hidden tabIndex={-1} className="hidden" onSeeked={paintPreview} />
    </div>
  )
}
