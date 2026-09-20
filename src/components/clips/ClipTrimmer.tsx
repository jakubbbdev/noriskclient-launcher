"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { Button } from "../ui/buttons/Button";
import { Input } from "../ui/Input";
import { RangeSlider } from "../ui/RangeSlider";
import { useThemeStore } from "../../store/useThemeStore";
import {
  exportVertical,
  type ClipCorner,
  type ClipDetails,
  type ClipOverlay,
  type ClipShape,
  type ExportProgress,
  type ExportedClip,
  type TrackLevel,
} from "../../services/clip-service";
import { TrackLevelControl, Waveform, trackName } from "./ClipTimeline";
import { ClipIconButton } from "./ClipIconButton";
import { cn } from "../../lib/utils";
import { parseErrorMessage } from "../../utils/error-utils";
import { useTrimPreview } from "./useTrimPreview";

const MIN_LENGTH = 0.5;

const FILMSTRIP_FRAMES = 14;

const THUMB_WIDTH = 160;
const THUMB_HEIGHT = 90;

const NUDGE = 0.1;

const MIN_BOX = 0.05;

const DEFAULT_BLUR = 12;

type NewOverlay =
  | { kind: "blur"; strength: number }
  | { kind: "box"; colour: number }
  | { kind: "arrow"; colour: number; thickness: number; towards: ClipCorner }
  | { kind: "text"; content: string; size: number; colour: number };

const TOOLS: { icon: string; label: string; seed: NewOverlay }[] = [
  {
    icon: "solar:magic-stick-bold",
    label: "clips.editor.tool.blur",
    seed: { kind: "blur", strength: DEFAULT_BLUR },
  },
  {
    icon: "solar:stop-bold",
    label: "clips.editor.tool.box",
    seed: { kind: "box", colour: 0xffffff },
  },
  {
    icon: "solar:arrow-right-up-bold",
    label: "clips.editor.tool.arrow",
    seed: { kind: "arrow", colour: 0xffffff, thickness: 6, towards: "bottom_right" },
  },
  {
    icon: "solar:text-bold",
    label: "clips.editor.tool.text",
    seed: { kind: "text", content: "", size: 48, colour: 0xffffff },
  },
];

const OVERLAY_NAME: Record<ClipOverlay["kind"], string> = {
  blur: "clips.editor.overlay.name",
  box: "clips.editor.overlay.name_box",
  arrow: "clips.editor.overlay.name_arrow",
  text: "clips.editor.overlay.name_text",
};

const SWATCHES: number[] = [0xffffff, 0x000000, 0xff3b30, 0xffcc00, 0x34c759, 0x0a84ff];

const CORNERS: { value: ClipCorner; label: string; turn: number }[] = [
  { value: "top_left", label: "clips.editor.overlay.corner.top_left", turn: -90 },
  { value: "top_right", label: "clips.editor.overlay.corner.top_right", turn: 0 },
  { value: "bottom_left", label: "clips.editor.overlay.corner.bottom_left", turn: 180 },
  { value: "bottom_right", label: "clips.editor.overlay.corner.bottom_right", turn: 90 },
];

function grey(colour: number): string {
  return `#${colour.toString(16).padStart(6, "0")}`;
}

type ShapeChoice = ClipShape | "original";

const SHAPES: { choice: ShapeChoice; ratio: number | null; label: string }[] = [
  { choice: "original", ratio: null, label: "clips.editor.shape.original" },
  { choice: "vertical", ratio: 9 / 16, label: "clips.editor.shape.vertical" },
  { choice: "square", ratio: 1, label: "clips.editor.shape.square" },
  { choice: "wide", ratio: 21 / 9, label: "clips.editor.shape.wide" },
];

interface BoxDrag {
  index: number;
  mode: "move" | "resize";
  fromX: number;
  fromY: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface BarDrag {
  index: number;
  mode: "move" | "start" | "end";
  fromX: number;
  startSeconds: number;
  endSeconds: number;
}

type ExportStage =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number }
  | { kind: "done" }
  | { kind: "failed"; why: string };

interface Props {
  src: string;
  path: string;
  duration: number;
  busy: boolean;
  details: ClipDetails | null;
  onCancel: () => void;
  onSave: (startSeconds: number, endSeconds: number, levels: TrackLevel[]) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function ClipTrimmer({
  src,
  path,
  duration,
  busy,
  details,
  onCancel,
  onSave,
  t,
}: Props) {
  const accentColor = useThemeStore((state) => state.accentColor);
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [ratio, setRatio] = useState(16 / 9);
  const [overlays, setOverlays] = useState<ClipOverlay[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [shape, setShape] = useState<ShapeChoice>("original");
  const [boxDrag, setBoxDrag] = useState<BoxDrag | null>(null);
  const [barDrag, setBarDrag] = useState<BarDrag | null>(null);
  const [stage, setStage] = useState<ExportStage>({ kind: "idle" });

  const lanes = useMemo(() => details?.audioTracks ?? [], [details]);
  const adjustable = useMemo(() => lanes.filter((track) => track.adjustable), [lanes]);

  const [volumes, setVolumes] = useState<Record<number, number>>({});
  useEffect(() => {
    setVolumes(Object.fromEntries(adjustable.map((track) => [track.stream, 100])));
  }, [adjustable]);

  const levels: TrackLevel[] = useMemo(
    () => adjustable.map((track) => ({ stream: track.stream, volume: volumes[track.stream] ?? 100 })),
    [adjustable, volumes],
  );
  const rebalanced = levels.some((level) => level.volume !== 100);

  const previewState = useTrimPreview({
    path,
    video: videoRef,
    levels,
    active: adjustable.length > 0,
  });

  const drawn = adjustable.length > 0 ? adjustable : lanes;

  useEffect(() => {
    if (duration > 0) setEnd((current) => (current === 0 ? duration : Math.min(current, duration)));
  }, [duration]);

  const filmstrip = useFilmstrip(src, duration);

  const kept = Math.max(0, end - start);
  const percent = useCallback(
    (seconds: number) => (duration > 0 ? (seconds / duration) * 100 : 0),
    [duration],
  );

  const seek = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (video) video.currentTime = Math.max(0, Math.min(seconds, duration));
    },
    [duration],
  );

  const secondsAt = useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      if (!bar || duration <= 0) return 0;
      const rect = bar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
    },
    [duration],
  );

  const moveHandle = useCallback(
    (which: "start" | "end", seconds: number) => {
      if (which === "start") {
        const next = Math.max(0, Math.min(seconds, end - MIN_LENGTH));
        setStart(next);
        seek(next);
      } else {
        const next = Math.min(duration, Math.max(seconds, start + MIN_LENGTH));
        setEnd(next);
        seek(next);
      }
    },
    [duration, end, seek, start],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => moveHandle(dragging, secondsAt(event.clientX));
    const up = () => setDragging(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, moveHandle, secondsAt]);

  const editOverlay = useCallback((index: number, patch: Partial<ClipOverlay>) => {
    setOverlays((current) =>
      current.map((overlay, at) =>
        at === index ? ({ ...overlay, ...patch } as ClipOverlay) : overlay,
      ),
    );
  }, []);

  const addOverlay = useCallback(
    (seed: NewOverlay) => {
      setOverlays((current) => [
        ...current,
        {
          ...seed,
          left: 0.25,
          top: 0.25,
          width: 0.5,
          height: 0.5,
          startSeconds: start,
          endSeconds: end,
        },
      ]);
      setChosen(overlays.length);
    },
    [end, overlays.length, start],
  );

  const dropOverlay = useCallback((index: number) => {
    setOverlays((current) => current.filter((_, at) => at !== index));
    setChosen(null);
  }, []);

  useEffect(() => {
    if (!boxDrag) return;
    const move = (event: PointerEvent) => {
      const rect = frameRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      const byX = (event.clientX - boxDrag.fromX) / rect.width;
      const byY = (event.clientY - boxDrag.fromY) / rect.height;
      if (boxDrag.mode === "move") {
        editOverlay(boxDrag.index, {
          left: clamp(boxDrag.left + byX, 0, 1 - boxDrag.width),
          top: clamp(boxDrag.top + byY, 0, 1 - boxDrag.height),
        });
      } else {
        editOverlay(boxDrag.index, {
          width: clamp(boxDrag.width + byX, MIN_BOX, 1 - boxDrag.left),
          height: clamp(boxDrag.height + byY, MIN_BOX, 1 - boxDrag.top),
        });
      }
    };
    const up = () => setBoxDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [boxDrag, editOverlay]);

  useEffect(() => {
    if (!barDrag) return;
    const move = (event: PointerEvent) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || duration <= 0) return;
      const by = ((event.clientX - barDrag.fromX) / rect.width) * duration;
      if (barDrag.mode === "move") {
        const span = barDrag.endSeconds - barDrag.startSeconds;
        const from = clamp(barDrag.startSeconds + by, 0, duration - span);
        editOverlay(barDrag.index, { startSeconds: from, endSeconds: from + span });
      } else if (barDrag.mode === "start") {
        editOverlay(barDrag.index, {
          startSeconds: clamp(barDrag.startSeconds + by, 0, barDrag.endSeconds - MIN_LENGTH),
        });
      } else {
        editOverlay(barDrag.index, {
          endSeconds: clamp(barDrag.endSeconds + by, barDrag.startSeconds + MIN_LENGTH, duration),
        });
      }
    };
    const up = () => setBarDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [barDrag, duration, editOverlay]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let alive = true;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const stops = await Promise.all([
        listen<ExportProgress>("clip_export_progress", (event) => {
          if (!samePath(event.payload.source, path)) return;
          setStage({ kind: "running", done: event.payload.done, total: event.payload.total });
        }),
        listen<ExportedClip>("clip_exported", (event) => {
          if (!samePath(event.payload.source, path)) return;
          setStage({ kind: "done" });
        }),
      ]);
      if (!alive) {
        stops.forEach((off) => off());
        return;
      }
      stop = () => stops.forEach((off) => off());
    })();

    return () => {
      alive = false;
      stop?.();
    };
  }, [path]);

  const runExport = useCallback(async () => {
    if (shape === "original") return;
    setStage({ kind: "running", done: 0, total: 0 });
    try {
      await exportVertical(path, shape, overlays);
    } catch (e) {
      console.error("Could not export the clip", e);
      setStage({ kind: "failed", why: parseErrorMessage(e) });
    }
  }, [overlays, path, shape]);

  const guide = useMemo(() => {
    const target = SHAPES.find((entry) => entry.choice === shape)?.ratio;
    if (!target || ratio <= 0) return null;
    return ratio > target
      ? { width: target / ratio, height: 1 }
      : { width: 1, height: ratio / target };
  }, [ratio, shape]);

  const picked = chosen === null ? null : (overlays[chosen] ?? null);

  const exportPercent =
    stage.kind === "running" && stage.total > 0
      ? Math.round((stage.done / stage.total) * 100)
      : null;

  const preview = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    video.currentTime = start;
    void video.play().catch(() => {});
  }, [start]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      setPlayhead(video.currentTime);
      if (!video.paused && video.currentTime >= end) video.pause();
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [end]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <div className="flex shrink-0 flex-col items-center gap-2 rounded-lg bg-black/20 border border-white/10 px-2 py-2">
          <span className="font-smallcaps text-[0.65rem] uppercase tracking-wider text-white/40">
            {t("clips.editor.tools")}
          </span>
          {TOOLS.map((tool) => (
            <ClipIconButton
              key={tool.seed.kind}
              icon={tool.icon}
              label={t(tool.label)}
              onClick={() => addOverlay(tool.seed)}
              disabled={busy}
            />
          ))}
        </div>

        <div
          ref={frameRef}
          className="relative mx-auto w-full overflow-hidden rounded-lg bg-black border border-white/10"
          style={{ aspectRatio: `${ratio}`, maxWidth: `calc(56vh * ${ratio})` }}
        >
          <video
            ref={videoRef}
            src={src}
            className="block h-full w-full object-contain"
            onClick={preview}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (video.videoWidth > 0 && video.videoHeight > 0) {
                setRatio(video.videoWidth / video.videoHeight);
              }
            }}
          />

          {!playing && (
            <button
              type="button"
              onClick={preview}
              aria-label={t("clips.trim.preview")}
              className="absolute inset-0 flex items-center justify-center bg-black/30 backdrop-blur-[2px] transition-colors hover:bg-black/40"
            >
              <span
                className="flex h-14 w-14 items-center justify-center rounded-full border border-white/20"
                style={{ backgroundColor: `${accentColor.value}40` }}
              >
                <Icon icon="solar:play-bold" className="h-7 w-7 text-white" />
              </span>
            </button>
          )}

          {guide && (
            <div
              className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border-2"
              style={{
                width: `${guide.width * 100}%`,
                height: `${guide.height * 100}%`,
                borderColor: accentColor.value,
                boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55)",
              }}
            />
          )}

          {overlays.map((overlay, index) => (
            <OverlayBox
              key={index}
              overlay={overlay}
              active={chosen === index}
              color={accentColor.value}
              label={t(OVERLAY_NAME[overlay.kind], { index: index + 1 })}
              onPick={() => setChosen(index)}
              onGrab={(mode, event) => {
                setChosen(index);
                setBoxDrag({
                  index,
                  mode,
                  fromX: event.clientX,
                  fromY: event.clientY,
                  left: overlay.left,
                  top: overlay.top,
                  width: overlay.width,
                  height: overlay.height,
                });
              }}
            />
          ))}
        </div>
      </div>

      <div className="flex items-end justify-center gap-8">
        <Readout label={t("clips.trim.from")} value={formatTime(start)} />
        <div className="flex flex-col items-center">
          <span className="font-minecraft text-3xl text-white">
            {kept.toFixed(1)}
            <span className="ml-1 text-lg text-white/50">s</span>
          </span>
          <span className="font-smallcaps text-xs uppercase tracking-wider text-white/50">
            {t("clips.trim.kept_label")}
          </span>
        </div>
        <Readout label={t("clips.trim.to")} value={formatTime(end)} />
      </div>

      <div className="flex flex-col gap-2">
        <div
          ref={barRef}
          className="relative select-none overflow-hidden rounded-lg bg-black/40 border border-white/10"
          onPointerDown={(event) => {
            const seconds = secondsAt(event.clientX);
            seek(seconds);
            setPlayhead(seconds);
          }}
          role="presentation"
        >
          <div className="relative h-16">
            {filmstrip ? (
              <img
                src={filmstrip}
                alt=""
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-90"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <Icon icon="svg-spinners:ring-resize" className="h-4 w-4 text-white/40" />
              </div>
            )}
          </div>

          {drawn.map((track) => {
            const volume = track.adjustable ? (volumes[track.stream] ?? 100) : 100;
            return (
              <div
                key={track.stream}
                className="relative h-12 border-t border-white/10"
                style={{ color: accentColor.light }}
              >
                <Waveform peaks={track.peaks} gain={volume / 100} muted={volume === 0} />
                <span className="pointer-events-none absolute left-2 top-1.5 font-smallcaps text-xs uppercase tracking-wider text-white/50">
                  {trackName(track.label, t)}
                </span>
              </div>
            );
          })}

          <div
            className="pointer-events-none absolute inset-y-0 left-0 bg-black/70"
            style={{ width: `${percent(start)}%` }}
          />
          <div
            className="pointer-events-none absolute inset-y-0 right-0 bg-black/70"
            style={{ width: `${100 - percent(end)}%` }}
          />

          <div
            className="pointer-events-none absolute inset-y-0 border-x-2"
            style={{
              left: `${percent(start)}%`,
              width: `${percent(kept)}%`,
              borderColor: accentColor.value,
            }}
          />

          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]"
            style={{ left: `${percent(playhead)}%` }}
          />

          <Handle
            left={percent(start)}
            active={dragging === "start"}
            time={formatTime(start)}
            label={t("clips.trim.handle_start")}
            color={accentColor.value}
            onGrab={() => setDragging("start")}
            onNudge={(by) => moveHandle("start", start + by)}
          />
          <Handle
            left={percent(end)}
            active={dragging === "end"}
            time={formatTime(end)}
            label={t("clips.trim.handle_end")}
            color={accentColor.value}
            onGrab={() => setDragging("end")}
            onNudge={(by) => moveHandle("end", end + by)}
          />
        </div>

        {overlays.length > 0 && (
          <div ref={trackRef} className="flex select-none flex-col gap-1">
            {overlays.map((overlay, index) => (
              <OverlayBar
                key={index}
                overlay={overlay}
                duration={duration}
                active={chosen === index}
                color={accentColor.value}
                name={t(OVERLAY_NAME[overlay.kind], { index: index + 1 })}
                onPick={() => setChosen(index)}
                onGrab={(mode, event) => {
                  setChosen(index);
                  setBarDrag({
                    index,
                    mode,
                    fromX: event.clientX,
                    startSeconds: overlay.startSeconds,
                    endSeconds: overlay.endSeconds,
                  });
                }}
              />
            ))}
          </div>
        )}

        <p className="min-h-[1.25rem] font-minecraft text-xs text-white/50">
          {overlays.length > 0 ? t("clips.editor.overlay.hint") : t("clips.trim.hint")}
        </p>
      </div>

      {picked !== null && chosen !== null && (
        <div className="flex flex-wrap items-center gap-4 rounded-lg bg-black/20 border border-white/10 px-4 py-3">
          {picked.kind === "blur" && (
            <PropSlider
              label={t("clips.editor.overlay.strength")}
              value={picked.strength}
              min={1}
              max={64}
              disabled={busy}
              onChange={(strength) => editOverlay(chosen, { strength })}
            />
          )}

          {picked.kind === "box" && (
            <ShadeChoice
              label={t("clips.editor.overlay.colour")}
              value={picked.colour}
              disabled={busy}
              onChange={(colour) => editOverlay(chosen, { colour })}
              t={t}
            />
          )}

          {picked.kind === "arrow" && (
            <>
              <ShadeChoice
                label={t("clips.editor.overlay.colour")}
                value={picked.colour}
                disabled={busy}
                onChange={(colour) => editOverlay(chosen, { colour })}
                t={t}
              />
              <PropSlider
                label={t("clips.editor.overlay.thickness")}
                value={picked.thickness}
                min={1}
                max={32}
                disabled={busy}
                onChange={(thickness) => editOverlay(chosen, { thickness })}
              />
              <CornerChoice
                label={t("clips.editor.overlay.towards")}
                value={picked.towards}
                color={accentColor.value}
                disabled={busy}
                onChange={(towards) => editOverlay(chosen, { towards })}
                t={t}
              />
            </>
          )}

          {picked.kind === "text" && (
            <>
              <div className="flex min-w-[14rem] flex-1 items-center gap-3">
                <span className="shrink-0 font-minecraft text-sm text-white/80">
                  {t("clips.editor.overlay.text")}
                </span>
                <Input
                  size="sm"
                  value={picked.content}
                  disabled={busy}
                  placeholder={t("clips.editor.overlay.text_placeholder")}
                  aria-label={t("clips.editor.overlay.text")}
                  onChange={(event) => editOverlay(chosen, { content: event.target.value })}
                />
              </div>
              <PropSlider
                label={t("clips.editor.overlay.size")}
                value={picked.size}
                min={8}
                max={240}
                disabled={busy}
                onChange={(size) => editOverlay(chosen, { size })}
              />
              <ShadeChoice
                label={t("clips.editor.overlay.colour")}
                value={picked.colour}
                disabled={busy}
                onChange={(colour) => editOverlay(chosen, { colour })}
                t={t}
              />
              {picked.content.trim() === "" && (
                <p className="flex w-full items-center gap-2 font-minecraft text-xs text-amber-300">
                  <Icon icon="solar:danger-triangle-bold" className="h-4 w-4 shrink-0" />
                  {t("clips.editor.overlay.text_empty")}
                </p>
              )}
            </>
          )}

          <ClipIconButton
            icon="solar:trash-bin-trash-bold"
            label={t("clips.editor.overlay.remove")}
            tone="danger"
            tooltipPosition="top"
            onClick={() => dropOverlay(chosen)}
            disabled={busy}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-black/20 border border-white/10 px-4 py-3">
        <span className="font-smallcaps text-xs uppercase tracking-wider text-white/50">
          {t("clips.editor.shape.label")}
        </span>
        {SHAPES.map((entry) => (
          <button
            key={entry.choice}
            type="button"
            onClick={() => setShape(entry.choice)}
            disabled={busy}
            className={cn(
              "rounded border px-2.5 py-1 font-minecraft text-xs transition-colors",
              shape === entry.choice
                ? "text-white"
                : "border-white/10 bg-black/30 text-white/60 hover:text-white",
            )}
            style={
              shape === entry.choice
                ? { borderColor: accentColor.value, backgroundColor: `${accentColor.value}30` }
                : undefined
            }
          >
            {t(entry.label)}
          </button>
        ))}
      </div>

      {adjustable.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg bg-black/20 border border-white/10 px-4 py-3">
          {adjustable.map((track) => (
            <TrackLevelControl
              key={track.stream}
              track={track}
              name={trackName(track.label, t)}
              volume={volumes[track.stream] ?? 100}
              onChange={(volume) =>
                setVolumes((current) => ({ ...current, [track.stream]: volume }))
              }
              disabled={busy}
              t={t}
            />
          ))}
          <p className="font-minecraft text-xs leading-relaxed text-white/50">
            {previewState === "live"
              ? t("clips.trim.levels.live")
              : previewState === "loading"
                ? t("clips.trim.levels.preparing")
                : rebalanced
                  ? t("clips.trim.levels.rebuilt")
                  : t("clips.trim.levels.untouched")}
          </p>
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-white/10 pt-4">
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon icon={playing ? "solar:pause-bold" : "solar:play-bold"} className="w-4 h-4" />}
          onClick={preview}
        >
          {t("clips.trim.preview")}
        </Button>

        {stage.kind === "running" ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-4">
            <div className="h-1.5 overflow-hidden rounded-full bg-black/40 border border-white/10">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-200",
                  exportPercent === null && "w-1/3 animate-pulse",
                )}
                style={{
                  backgroundColor: accentColor.value,
                  width: exportPercent === null ? undefined : `${Math.max(2, exportPercent)}%`,
                }}
              />
            </div>
            <p className="font-minecraft text-xs text-white/60">
              {exportPercent === null
                ? t("clips.editor.export.starting")
                : t("clips.editor.export.progress", { percent: exportPercent })}
            </p>
          </div>
        ) : (
          <p className="min-w-0 flex-1 truncate px-4 font-minecraft text-xs text-white/60">
            {stage.kind === "failed"
              ? stage.why
              : stage.kind === "done"
                ? t("clips.editor.export.done")
                : shape === "original"
                  ? t("clips.editor.export.needs_shape")
                  : ""}
          </p>
        )}

        <Button
          variant="secondary"
          size="sm"
          onClick={() => void runExport()}
          disabled={busy || shape === "original" || stage.kind === "running"}
          icon={
            <Icon
              icon={stage.kind === "running" ? "svg-spinners:ring-resize" : "solar:smartphone-bold"}
              className="w-4 h-4"
            />
          }
        >
          {stage.kind === "failed" ? t("clips.editor.export.retry") : t("clips.editor.export.action")}
        </Button>

        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          {t("clips.trim.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={() => onSave(start, end, levels)}
          disabled={busy || kept < MIN_LENGTH}
          icon={
            <Icon
              icon={busy ? "svg-spinners:ring-resize" : "solar:scissors-bold"}
              className="w-4 h-4"
            />
          }
        >
          {t("clips.trim.save")}
        </Button>
      </div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center pb-1">
      <span className="font-minecraft text-base text-white/80">{value}</span>
      <span className="font-smallcaps text-xs uppercase tracking-wider text-white/50">{label}</span>
    </div>
  );
}

function Handle({
  left,
  active,
  time,
  label,
  color,
  onGrab,
  onNudge,
}: {
  left: number;
  active: boolean;
  time: string;
  label: string;
  color: string;
  onGrab: () => void;
  onNudge: (by: number) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(event) => {
        event.stopPropagation();
        onGrab();
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const step = event.shiftKey ? NUDGE * 10 : NUDGE;
        onNudge(event.key === "ArrowLeft" ? -step : step);
      }}
      className="group absolute inset-y-0 w-6 -translate-x-1/2 cursor-ew-resize focus:outline-none"
      style={{ left: `${left}%` }}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-1/2 w-1.5 -translate-x-1/2 rounded-full transition-all",
          active ? "opacity-100" : "opacity-80 group-hover:opacity-100 group-focus-visible:opacity-100",
        )}
        style={{ backgroundColor: color, boxShadow: active ? `0 0 8px ${color}` : undefined }}
      />
      <span
        className={cn(
          "pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 -translate-y-full rounded bg-black/80 border border-white/10 px-1.5 py-0.5 font-minecraft text-xs text-white transition-opacity",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        {time}
      </span>
    </button>
  );
}

function PropSlider({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex min-w-[14rem] flex-1 items-center gap-3">
      <span className="shrink-0 truncate font-minecraft text-sm text-white/80">{label}</span>
      <div className="min-w-0 flex-1">
        <RangeSlider
          value={value}
          onChange={onChange}
          min={min}
          max={max}
          step={1}
          size="sm"
          showValue={false}
          disabled={disabled}
          label={label}
        />
      </div>
      <span className="w-10 shrink-0 text-right font-minecraft text-sm text-white">{value}</span>
    </div>
  );
}

function ShadeChoice({
  label,
  value,
  disabled,
  onChange,
  t,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (colour: number) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const [typed, setTyped] = useState(grey(value));

  useEffect(() => {
    setTyped(grey(value));
  }, [value]);

  const accept = (text: string) => {
    setTyped(text);
    const cleaned = text.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(cleaned)) onChange(parseInt(cleaned, 16));
  };

  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="font-minecraft text-sm text-white/80">{label}</span>

      <label
        className={cn(
          "relative h-7 w-7 shrink-0 overflow-hidden rounded border border-white/20",
          disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:border-white/60",
        )}
        style={{ backgroundColor: grey(value) }}
        title={t("clips.editor.overlay.colour.pick")}
      >
        <input
          type="color"
          value={grey(value)}
          disabled={disabled}
          aria-label={t("clips.editor.overlay.colour.pick")}
          onChange={(event) => accept(event.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>

      <input
        type="text"
        value={typed}
        disabled={disabled}
        spellCheck={false}
        maxLength={7}
        aria-label={t("clips.editor.overlay.colour.hex")}
        onChange={(event) => accept(event.target.value)}
        onBlur={() => setTyped(grey(value))}
        className={cn(
          "w-24 rounded border border-white/20 bg-black/30 px-2 py-1 font-minecraft text-sm uppercase text-white/90 outline-none transition-colors",
          disabled ? "cursor-not-allowed opacity-40" : "hover:border-white/40 focus:border-white/60",
        )}
      />

      {SWATCHES.map((preset) => (
        <button
          key={preset}
          type="button"
          disabled={disabled}
          aria-label={grey(preset)}
          title={grey(preset)}
          onClick={() => onChange(preset)}
          className={cn(
            "h-5 w-5 shrink-0 rounded border transition-colors",
            value === preset ? "border-white" : "border-white/20 hover:border-white/60",
            disabled && "cursor-not-allowed opacity-40",
          )}
          style={{ backgroundColor: grey(preset) }}
        />
      ))}
    </div>
  );
}

function CornerChoice({
  label,
  value,
  color,
  disabled,
  onChange,
  t,
}: {
  label: string;
  value: ClipCorner;
  color: string;
  disabled: boolean;
  onChange: (corner: ClipCorner) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="font-minecraft text-sm text-white/80">{label}</span>
      <div className="grid grid-cols-2 gap-1">
        {CORNERS.map((corner) => (
          <button
            key={corner.value}
            type="button"
            disabled={disabled}
            aria-label={t(corner.label)}
            aria-pressed={value === corner.value}
            title={t(corner.label)}
            onClick={() => onChange(corner.value)}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded border transition-colors",
              value === corner.value
                ? "text-white"
                : "border-white/10 bg-black/30 text-white/50 hover:text-white",
              disabled && "cursor-not-allowed opacity-40",
            )}
            style={
              value === corner.value
                ? { borderColor: color, backgroundColor: `${color}30` }
                : undefined
            }
          >
            <Icon
              icon="solar:arrow-right-up-bold"
              className="h-3.5 w-3.5"
              style={{ transform: `rotate(${corner.turn}deg)` }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

function OverlayArt({ overlay }: { overlay: ClipOverlay }) {
  if (overlay.kind === "box") {
    return (
      <span
        className="pointer-events-none absolute inset-0"
        style={{ backgroundColor: grey(overlay.colour) }}
      />
    );
  }

  const width = Math.max(1, overlay.width * 1920);
  const height = Math.max(1, overlay.height * 1080);

  if (overlay.kind === "arrow") {
    const toX = overlay.towards.endsWith("right") ? width : 0;
    const toY = overlay.towards.startsWith("bottom") ? height : 0;
    const head = Math.min(width, height) * 0.3;
    return (
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        <g
          fill="none"
          stroke={grey(overlay.colour)}
          strokeWidth={overlay.thickness}
          strokeLinecap="round"
        >
          <line x1={width - toX} y1={height - toY} x2={toX} y2={toY} />
          <line x1={toX} y1={toY} x2={toX === 0 ? head : width - head} y2={toY} />
          <line x1={toX} y1={toY} x2={toX} y2={toY === 0 ? head : height - head} />
        </g>
      </svg>
    );
  }

  if (overlay.kind === "text" && overlay.content.trim() !== "") {
    return (
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMinYMid meet"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        <text
          x={0}
          y={height / 2}
          fill={grey(overlay.colour)}
          fontSize={overlay.size}
          dominantBaseline="middle"
        >
          {overlay.content}
        </text>
      </svg>
    );
  }

  return null;
}

function OverlayBox({
  overlay,
  active,
  color,
  label,
  onPick,
  onGrab,
}: {
  overlay: ClipOverlay;
  active: boolean;
  color: string;
  label: string;
  onPick: () => void;
  onGrab: (mode: "move" | "resize", event: { clientX: number; clientY: number }) => void;
}) {
  const blank = overlay.kind === "text" && overlay.content.trim() === "";

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={active}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onGrab("move", event);
      }}
      onClick={(event) => {
        event.stopPropagation();
        onPick();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onPick();
      }}
      className={cn(
        "absolute cursor-move rounded-sm border-2 transition-colors focus:outline-none",
        active ? "bg-white/5" : "border-white/40 bg-black/10 hover:border-white/70",
        blank && "border-dashed",
      )}
      style={{
        left: `${overlay.left * 100}%`,
        top: `${overlay.top * 100}%`,
        width: `${overlay.width * 100}%`,
        height: `${overlay.height * 100}%`,
        backdropFilter:
          overlay.kind === "blur" ? `blur(${Math.max(1, overlay.strength / 4)}px)` : undefined,
        borderColor: blank ? "#fcd34d" : active ? color : undefined,
        boxShadow: active ? `0 0 10px ${color}80` : undefined,
      }}
    >
      <OverlayArt overlay={overlay} />

      <span
        role="presentation"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onGrab("resize", event);
        }}
        className="absolute -bottom-1 -right-1 h-3.5 w-3.5 cursor-nwse-resize rounded-sm border border-black/50"
        style={{ backgroundColor: active ? color : "rgba(255, 255, 255, 0.7)" }}
      />
    </div>
  );
}

function OverlayBar({
  overlay,
  duration,
  active,
  color,
  name,
  onPick,
  onGrab,
}: {
  overlay: ClipOverlay;
  duration: number;
  active: boolean;
  color: string;
  name: string;
  onPick: () => void;
  onGrab: (mode: "move" | "start" | "end", event: { clientX: number }) => void;
}) {
  const span = duration > 0 ? duration : 1;
  const left = (overlay.startSeconds / span) * 100;
  const width = ((overlay.endSeconds - overlay.startSeconds) / span) * 100;

  return (
    <div className="relative h-7 overflow-hidden rounded bg-black/40 border border-white/10">
      <div
        role="button"
        tabIndex={0}
        aria-label={name}
        aria-pressed={active}
        onPointerDown={(event) => {
          event.preventDefault();
          onGrab("move", event);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onPick();
        }}
        className={cn(
          "absolute inset-y-0 flex cursor-grab items-center justify-center rounded border focus:outline-none",
          active ? "" : "border-white/20 bg-white/10 hover:bg-white/20",
        )}
        style={{
          left: `${left}%`,
          width: `${width}%`,
          borderColor: active ? color : undefined,
          backgroundColor: active ? `${color}50` : undefined,
        }}
      >
        <span className="pointer-events-none truncate px-3 font-minecraft text-xs text-white/80">
          {name}
        </span>
        <span
          role="presentation"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onGrab("start", event);
          }}
          className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-white/30 hover:bg-white/60"
        />
        <span
          role="presentation"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onGrab("end", event);
          }}
          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-white/30 hover:bg-white/60"
        />
      </div>
    </div>
  );
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}

function samePath(a: string, b: string): boolean {
  const flatten = (path: string) => path.replace(/\\/g, "/").toLowerCase();
  return flatten(a) === flatten(b);
}

function useFilmstrip(src: string, duration: number): string | null {
  const [strip, setStrip] = useState<string | null>(null);

  useEffect(() => {
    setStrip(null);
    if (duration <= 0) return;

    let cancelled = false;
    const video = document.createElement("video");
    video.src = src;
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";

    const canvas = document.createElement("canvas");
    canvas.width = THUMB_WIDTH * FILMSTRIP_FRAMES;
    canvas.height = THUMB_HEIGHT;
    const context = canvas.getContext("2d");

    const seekTo = (seconds: number) =>
      new Promise<void>((resolve, reject) => {
        const done = () => {
          video.removeEventListener("seeked", done);
          video.removeEventListener("error", fail);
          resolve();
        };
        const fail = () => {
          video.removeEventListener("seeked", done);
          video.removeEventListener("error", fail);
          reject(new Error("seek failed"));
        };
        video.addEventListener("seeked", done);
        video.addEventListener("error", fail);
        video.currentTime = seconds;
      });

    void (async () => {
      try {
        if (!context) return;
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("loadeddata", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(new Error("load failed")), { once: true });
        });

        for (let i = 0; i < FILMSTRIP_FRAMES; i++) {
          if (cancelled) return;
          await seekTo(((i + 0.5) / FILMSTRIP_FRAMES) * duration);
          if (cancelled) return;
          context.drawImage(video, i * THUMB_WIDTH, 0, THUMB_WIDTH, THUMB_HEIGHT);
        }

        if (!cancelled) setStrip(canvas.toDataURL("image/jpeg", 0.7));
      } catch {}
    })();

    return () => {
      cancelled = true;
      video.removeAttribute("src");
      video.load();
    };
  }, [src, duration]);

  return strip;
}

function formatTime(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  const tenths = Math.floor((seconds - whole) * 10);
  return `${minutes}:${String(rest).padStart(2, "0")}.${tenths}`;
}
