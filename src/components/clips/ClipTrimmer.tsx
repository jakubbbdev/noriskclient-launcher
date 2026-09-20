"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";

import { Button } from "../ui/buttons/Button";
import { Input } from "../ui/Input";
import { RangeSlider } from "../ui/RangeSlider";
import { useThemeStore } from "../../store/useThemeStore";
import {
  exportVertical,
  type ClipAudioTrack,
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
import { ColorPickerModal } from "../modals/ColorPickerModal";
import { useGlobalModal } from "../../hooks/useGlobalModal";

const MIN_LENGTH = 0.5;

const FILMSTRIP_FRAMES = 14;

const THUMB_WIDTH = 160;
const THUMB_HEIGHT = 90;

const NUDGE = 0.1;

const MIN_BOX = 0.05;

const DEFAULT_BLUR = 12;

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300];

const MAX_TICKS = 12;

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

const OVERLAY_ICON: Record<ClipOverlay["kind"], string> = {
  blur: "solar:magic-stick-bold",
  box: "solar:stop-bold",
  arrow: "solar:arrow-right-up-bold",
  text: "solar:text-bold",
};

const OVERLAY_COLOUR_MODAL = "clip-overlay-colour";

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

type Panel = "tools" | "audio" | "format";

const PANELS: { id: Panel; icon: string; label: string }[] = [
  { id: "tools", icon: "solar:widget-bold", label: "clips.editor.tools" },
  { id: "audio", icon: "solar:soundwave-bold", label: "clips.editor.audio" },
  { id: "format", icon: "solar:smartphone-bold", label: "clips.editor.shape.label" },
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

interface LaneDrag {
  stream: number;
  fromX: number;
  offsetSeconds: number;
}

interface LaneTrim {
  stream: number;
  edge: "start" | "end";
}

interface LaneWindow {
  start: number | null;
  end: number | null;
}

const NO_WINDOW: LaneWindow = { start: null, end: null };

type ExportStage =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number }
  | { kind: "done" }
  | { kind: "failed"; why: string };

type Translate = (key: string, options?: Record<string, unknown>) => string;

interface Props {
  src: string;
  path: string;
  name: string;
  duration: number;
  busy: boolean;
  details: ClipDetails | null;
  onCancel: () => void;
  onSave: (startSeconds: number, endSeconds: number, levels: TrackLevel[]) => void;
  t: Translate;
}

export function ClipTrimmer({
  src,
  path,
  name,
  duration,
  busy,
  details,
  onCancel,
  onSave,
  t,
}: Props) {
  const accentColor = useThemeStore((state) => state.accentColor);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);

  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [ratio, setRatio] = useState(16 / 9);
  const [overlays, setOverlays] = useState<ClipOverlay[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [shape, setShape] = useState<ShapeChoice>("original");
  const [panel, setPanel] = useState<Panel>("tools");
  const [boxDrag, setBoxDrag] = useState<BoxDrag | null>(null);
  const [barDrag, setBarDrag] = useState<BarDrag | null>(null);
  const [laneDrag, setLaneDrag] = useState<LaneDrag | null>(null);
  const [laneTrim, setLaneTrim] = useState<LaneTrim | null>(null);
  const [stage, setStage] = useState<ExportStage>({ kind: "idle" });

  const lanes = useMemo(() => details?.audioTracks ?? [], [details]);
  const adjustable = useMemo(() => lanes.filter((track) => track.adjustable), [lanes]);

  const [volumes, setVolumes] = useState<Record<number, number>>({});
  const [offsets, setOffsets] = useState<Record<number, number>>({});
  const [windows, setWindows] = useState<Record<number, LaneWindow>>({});
  useEffect(() => {
    setVolumes(Object.fromEntries(adjustable.map((track) => [track.stream, 100])));
    setOffsets(Object.fromEntries(adjustable.map((track) => [track.stream, 0])));
    setWindows(Object.fromEntries(adjustable.map((track) => [track.stream, NO_WINDOW])));
  }, [adjustable]);

  const levels: TrackLevel[] = useMemo(
    () =>
      adjustable.map((track) => {
        const own = laneWindow(windows[track.stream], start, end);
        return {
          stream: track.stream,
          volume: volumes[track.stream] ?? 100,
          offsetSeconds: offsets[track.stream] ?? 0,
          startSeconds: own.start,
          endSeconds: own.end,
        };
      }),
    [adjustable, end, offsets, start, volumes, windows],
  );
  const rebalanced = levels.some(
    (level) =>
      level.volume !== 100 ||
      level.offsetSeconds !== 0 ||
      level.startSeconds !== null ||
      level.endSeconds !== null,
  );

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

  const ticks = useMemo(() => {
    if (duration <= 0) return [];
    const step = TICK_STEPS.find((entry) => duration / entry <= MAX_TICKS) ?? 600;
    const out: number[] = [];
    for (let at = 0; at <= duration + 0.001; at += step) out.push(at);
    return out;
  }, [duration]);

  const seek = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (video) video.currentTime = Math.max(0, Math.min(seconds, duration));
    },
    [duration],
  );

  const secondsAt = useCallback(
    (clientX: number) => {
      const scale = scaleRef.current;
      if (!scale || duration <= 0) return 0;
      const rect = scale.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
    },
    [duration],
  );

  const scrubTo = useCallback(
    (clientX: number) => {
      const seconds = secondsAt(clientX);
      seek(seconds);
      setPlayhead(seconds);
    },
    [secondsAt, seek],
  );

  useEffect(() => {
    if (!scrubbing) return;
    const move = (event: PointerEvent) => scrubTo(event.clientX);
    const up = () => setScrubbing(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [scrubbing, scrubTo]);

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
      const rect = scaleRef.current?.getBoundingClientRect();
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

  const shiftTrack = useCallback(
    (stream: number, seconds: number) => {
      setOffsets((current) => ({ ...current, [stream]: tidy(clamp(seconds, -duration, duration)) }));
    },
    [duration],
  );

  useEffect(() => {
    if (!laneDrag) return;
    const move = (event: PointerEvent) => {
      const rect = scaleRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || duration <= 0) return;
      const by = ((event.clientX - laneDrag.fromX) / rect.width) * duration;
      shiftTrack(laneDrag.stream, laneDrag.offsetSeconds + by);
    };
    const up = () => setLaneDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [duration, laneDrag, shiftTrack]);

  const trimTrack = useCallback(
    (stream: number, edge: "start" | "end", seconds: number) => {
      setWindows((current) => {
        const own = laneWindow(current[stream], start, end);
        return {
          ...current,
          [stream]:
            edge === "start"
              ? { start: tidy(clamp(seconds, start, own.to - MIN_LENGTH)), end: own.end }
              : { start: own.start, end: tidy(clamp(seconds, own.from + MIN_LENGTH, end)) },
        };
      });
    },
    [end, start],
  );

  useEffect(() => {
    if (!laneTrim) return;
    const move = (event: PointerEvent) =>
      trimTrack(laneTrim.stream, laneTrim.edge, secondsAt(event.clientX));
    const up = () => setLaneTrim(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [laneTrim, secondsAt, trimTrack]);

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
    if (video.currentTime < start || video.currentTime >= end - 0.05) video.currentTime = start;
    void video.play().catch(() => {});
  }, [end, start]);

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

  const shapeLabel = SHAPES.find((entry) => entry.choice === shape)?.label ?? SHAPES[0].label;

  return (
    <div className="fixed inset-0 z-[1000] flex bg-black/70 p-4 backdrop-blur-md-anyos">
      <div
        className="relative flex min-h-0 w-full flex-col overflow-hidden rounded-lg border border-b-2"
        style={{
          backgroundColor: `${accentColor.value}20`,
          borderColor: `${accentColor.value}80`,
          borderBottomColor: accentColor.value,
        }}
      >
      <header
        className="relative flex shrink-0 items-center gap-3 border-b-2 px-5 py-3.5"
        style={{
          borderColor: `${accentColor.value}60`,
          backgroundColor: `${accentColor.value}30`,
        }}
      >
        <Icon
          icon="solar:videocamera-record-bold"
          className="h-6 w-6 shrink-0"
          style={{ color: accentColor.value }}
        />
        <span
          title={name}
          className="max-w-[20rem] truncate font-minecraft text-lg normal-case text-white"
        >
          {name}
        </span>

        <StateBadge stage={stage} percent={exportPercent} color={accentColor.value} t={t} />

        <span className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-1 font-smallcaps text-xs uppercase tracking-wider text-white/50">
          {t("clips.editor.shape.label")}: {t(shapeLabel)}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
            icon={<Icon icon="solar:close-circle-bold" className="w-4 h-4" />}
          >
            {t("clips.editor.exit")}
          </Button>
          <Button
            variant="secondary"
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
          <Button
            variant="default"
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
            {stage.kind === "failed"
              ? t("clips.editor.export.retry")
              : t("clips.editor.export.action")}
          </Button>
        </div>

        {stage.kind === "running" && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-white/10">
            <span
              className={cn(
                "block h-full transition-[width] duration-200",
                exportPercent === null && "w-1/3 animate-pulse",
              )}
              style={{
                backgroundColor: accentColor.value,
                width: exportPercent === null ? undefined : `${Math.max(2, exportPercent)}%`,
              }}
            />
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[5rem] shrink-0 flex-col gap-2 border-r border-white/10 bg-black/20 p-3">
          {PANELS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setPanel(entry.id)}
              aria-pressed={panel === entry.id}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2.5 transition-colors",
                panel === entry.id
                  ? "text-white"
                  : "border-white/10 bg-black/20 text-white/50 hover:border-white/20 hover:text-white",
              )}
              style={
                panel === entry.id
                  ? { borderColor: accentColor.value, backgroundColor: `${accentColor.value}25` }
                  : undefined
              }
            >
              <Icon icon={entry.icon} className="h-5 w-5" />
              <span className="font-smallcaps text-[0.6rem] uppercase tracking-wider">
                {t(entry.label)}
              </span>
            </button>
          ))}
        </nav>

        <aside className="custom-scrollbar flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-white/10 bg-black/20 p-4">
          {panel === "tools" && (
            <>
              <PanelTitle color={accentColor.value}>{t("clips.editor.tools")}</PanelTitle>
              <div className="flex flex-col gap-2">
                {TOOLS.map((tool) => (
                  <button
                    key={tool.seed.kind}
                    type="button"
                    onClick={() => addOverlay(tool.seed)}
                    disabled={busy}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-left font-minecraft text-sm text-white/80 transition-colors hover:border-white/20 hover:text-white",
                      busy && "cursor-not-allowed opacity-40",
                    )}
                  >
                    <Icon icon={tool.icon} className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{t(tool.label)}</span>
                    <Icon icon="solar:add-circle-bold" className="h-4 w-4 shrink-0 text-white/30" />
                  </button>
                ))}
              </div>
              <p className="font-minecraft text-xs leading-relaxed text-white/50">
                {t("clips.editor.tools.hint")}
              </p>
            </>
          )}

          {panel === "audio" && (
            <>
              <PanelTitle color={accentColor.value}>{t("clips.editor.audio")}</PanelTitle>
              {adjustable.length === 0 ? (
                <p className="font-minecraft text-xs leading-relaxed text-white/50">
                  {t("clips.editor.audio.none")}
                </p>
              ) : (
                <>
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
                </>
              )}
              <p className="font-minecraft text-xs leading-relaxed text-white/40">
                {t("clips.editor.audio.shift")}
              </p>
            </>
          )}

          {panel === "format" && (
            <>
              <PanelTitle color={accentColor.value}>{t("clips.editor.shape.label")}</PanelTitle>
              <div className="grid grid-cols-2 gap-2">
                {SHAPES.map((entry) => (
                  <button
                    key={entry.choice}
                    type="button"
                    onClick={() => setShape(entry.choice)}
                    disabled={busy}
                    className={cn(
                      "rounded-lg border px-2 py-2.5 font-minecraft text-xs transition-colors",
                      shape === entry.choice
                        ? "text-white"
                        : "border-white/10 bg-black/20 text-white/60 hover:border-white/20 hover:text-white",
                      busy && "cursor-not-allowed opacity-40",
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
              {shape === "original" && (
                <p className="font-minecraft text-xs leading-relaxed text-white/50">
                  {t("clips.editor.export.needs_shape")}
                </p>
              )}
            </>
          )}
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-6">
          <div
            ref={frameRef}
            className="relative w-full overflow-hidden rounded-lg border border-white/10 bg-black shadow-2xl"
            style={{ aspectRatio: `${ratio}`, maxWidth: `calc(48vh * ${ratio})` }}
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
                visible={playhead >= overlay.startSeconds && playhead <= overlay.endSeconds}
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
        </main>

        <aside className="custom-scrollbar flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-white/10 bg-black/20 p-4">
          <PanelTitle color={accentColor.value}>{t("clips.editor.inspector")}</PanelTitle>

          {picked === null || chosen === null ? (
            <p className="font-minecraft text-xs leading-relaxed text-white/50">
              {t("clips.editor.inspector.empty")}
            </p>
          ) : (
            <>
              <div
                className="flex items-center gap-2 rounded-lg border px-3 py-2.5"
                style={{
                  borderColor: `${accentColor.value}80`,
                  backgroundColor: `${accentColor.value}20`,
                }}
              >
                <Icon
                  icon={OVERLAY_ICON[picked.kind]}
                  className="h-4 w-4 shrink-0"
                  style={{ color: overlayTint(picked, accentColor.value) }}
                />
                <span className="min-w-0 flex-1 truncate font-minecraft text-sm text-white">
                  {t(OVERLAY_NAME[picked.kind], { index: chosen + 1 })}
                </span>
                <ClipIconButton
                  icon="solar:trash-bin-trash-bold"
                  label={t("clips.editor.overlay.remove")}
                  tone="danger"
                  tooltipPosition="bottom"
                  onClick={() => dropOverlay(chosen)}
                  disabled={busy}
                />
              </div>

              <p className="font-minecraft text-xs text-white/50">
                {t("clips.editor.overlay.window", {
                  from: formatTime(picked.startSeconds),
                  to: formatTime(picked.endSeconds),
                })}
              </p>

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
                  <div className="flex flex-col gap-1.5">
                    <span className="font-minecraft text-sm text-white/80">
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
                    <p className="flex items-start gap-2 font-minecraft text-xs leading-relaxed text-amber-300">
                      <Icon icon="solar:danger-triangle-bold" className="mt-0.5 h-4 w-4 shrink-0" />
                      {t("clips.editor.overlay.text_empty")}
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </aside>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-white/10 bg-black/20 px-5 py-3">
        <ClipIconButton
          icon="solar:restart-bold"
          label={t("clips.editor.transport.to_start")}
          tooltipPosition="top"
          onClick={() => {
            seek(start);
            setPlayhead(start);
          }}
        />
        <ClipIconButton
          icon={playing ? "solar:pause-bold" : "solar:play-bold"}
          label={playing ? t("clips.editor.transport.pause") : t("clips.trim.preview")}
          tooltipPosition="top"
          onClick={preview}
        />

        <span className="ml-2 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1 font-minecraft text-sm tabular-nums text-white/90">
          {formatTime(playhead)}
          <span className="text-white/40"> / {formatTime(duration)}</span>
        </span>

        <div className="ml-auto flex items-center gap-6">
          <Readout label={t("clips.trim.from")} value={formatTime(start)} />
          <Readout label={t("clips.trim.kept_label")} value={`${kept.toFixed(1)} s`} strong />
          <Readout label={t("clips.trim.to")} value={formatTime(end)} />
        </div>
      </div>

      <div className="custom-scrollbar max-h-[34vh] shrink-0 overflow-y-auto border-t border-white/10 bg-black/20 px-5 py-3">
        <div className="relative flex select-none flex-col gap-1.5">
          <div className="flex">
            <div className="w-44 shrink-0" />
            <div
              ref={scaleRef}
              role="presentation"
              onPointerDown={(event) => {
                scrubTo(event.clientX);
                setScrubbing(true);
              }}
              className="relative h-5 flex-1 cursor-ew-resize"
            >
              {ticks.map((at) => (
                <span
                  key={at}
                  className="absolute bottom-0 top-0 border-l border-white/20 pl-1 font-minecraft text-[0.6rem] leading-5 text-white/40"
                  style={{ left: `${percent(at)}%` }}
                >
                  {formatTick(at)}
                </span>
              ))}
            </div>
          </div>

          <Lane
            icon="solar:videocamera-bold"
            name={t("clips.editor.timeline.video")}
            tint={accentColor.value}
            height="h-14"
            onScrub={(clientX) => {
              scrubTo(clientX);
              setScrubbing(true);
            }}
          >
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
          </Lane>

          {drawn.map((track) => {
            const own = laneWindow(windows[track.stream], start, end);
            return (
              <AudioLane
                key={track.stream}
                track={track}
                name={trackName(track.label, t)}
                volume={track.adjustable ? (volumes[track.stream] ?? 100) : 100}
                offset={track.adjustable ? (offsets[track.stream] ?? 0) : 0}
                duration={duration}
                tone={accentColor.light}
                disabled={busy}
                clipFrom={start}
                clipTo={end}
                from={own.from}
                to={own.to}
                trimmed={own.start !== null || own.end !== null}
                trimming={laneTrim?.stream === track.stream ? laneTrim.edge : null}
                onChange={(volume) =>
                  setVolumes((current) => ({ ...current, [track.stream]: volume }))
                }
                onGrab={(event) =>
                  setLaneDrag({
                    stream: track.stream,
                    fromX: event.clientX,
                    offsetSeconds: offsets[track.stream] ?? 0,
                  })
                }
                onNudge={(by) => shiftTrack(track.stream, (offsets[track.stream] ?? 0) + by)}
                onReset={() => shiftTrack(track.stream, 0)}
                onTrim={(edge) => setLaneTrim({ stream: track.stream, edge })}
                onTrimNudge={(edge, by) =>
                  trimTrack(track.stream, edge, (edge === "start" ? own.from : own.to) + by)
                }
                onTrimReset={() =>
                  setWindows((current) => ({ ...current, [track.stream]: NO_WINDOW }))
                }
                t={t}
              />
            );
          })}

          {overlays.map((overlay, index) => (
            <OverlayLane
              key={index}
              overlay={overlay}
              duration={duration}
              active={chosen === index}
              accent={accentColor.value}
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

          <div className="pointer-events-none absolute inset-y-0 left-44 right-0">
            <div
              className="absolute inset-y-0 left-0 bg-black/70"
              style={{ width: `${percent(start)}%` }}
            />
            <div
              className="absolute inset-y-0 right-0 bg-black/70"
              style={{ width: `${100 - percent(end)}%` }}
            />
            <div
              className="absolute inset-y-0 border-x-2"
              style={{
                left: `${percent(start)}%`,
                width: `${percent(kept)}%`,
                borderColor: accentColor.value,
              }}
            />
            <div
              className="absolute inset-y-0 w-px bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]"
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
        </div>

        <p className="mt-2.5 min-h-[1.25rem] font-minecraft text-xs text-white/50">
          {overlays.length > 0 ? t("clips.editor.overlay.hint") : t("clips.trim.hint")}
        </p>
      </div>
      </div>
    </div>
  );
}

function PanelTitle({ children, color }: { children: ReactNode; color: string }) {
  return (
    <h3
      className="border-b border-white/10 pb-2 font-smallcaps text-lg leading-none tracking-wide"
      style={{ color }}
    >
      {children}
    </h3>
  );
}

function StateBadge({
  stage,
  percent,
  color,
  t,
}: {
  stage: ExportStage;
  percent: number | null;
  color: string;
  t: Translate;
}) {
  const look =
    stage.kind === "running"
      ? { icon: "svg-spinners:ring-resize", tone: "text-white", text: percent === null ? t("clips.editor.export.starting") : t("clips.editor.export.progress", { percent }) }
      : stage.kind === "done"
        ? { icon: "solar:check-circle-bold", tone: "text-emerald-300", text: t("clips.editor.export.done") }
        : stage.kind === "failed"
          ? { icon: "solar:danger-triangle-bold", tone: "text-red-300", text: stage.why }
          : { icon: "solar:stop-circle-bold", tone: "text-white/60", text: t("clips.editor.state.ready") };

  return (
    <span
      title={look.text}
      className={cn(
        "flex max-w-[18rem] items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1 font-minecraft text-xs",
        look.tone,
      )}
      style={stage.kind === "running" ? { borderColor: `${color}80` } : undefined}
    >
      <Icon icon={look.icon} className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{look.text}</span>
    </span>
  );
}

function Lane({
  icon,
  name,
  tint,
  height,
  active,
  control,
  tone,
  onPick,
  onScrub,
  children,
}: {
  icon: string;
  name: string;
  tint: string;
  height: string;
  active?: boolean;
  control?: ReactNode;
  tone?: string;
  onPick?: () => void;
  onScrub?: (clientX: number) => void;
  children?: ReactNode;
}) {
  const head = (
    <>
      <span className="h-4 w-1 shrink-0 rounded-full" style={{ backgroundColor: tint }} />
      <Icon icon={icon} className="h-3.5 w-3.5 shrink-0 text-white/50" />
      <span className="min-w-0 flex-1 truncate text-left font-minecraft text-xs text-white/70">
        {name}
      </span>
    </>
  );

  return (
    <div className="flex">
      <div
        className={cn(
          "flex w-44 shrink-0 items-center gap-2 rounded-l-lg border-y border-l border-white/10 bg-black/20 px-2.5",
          height,
        )}
        style={active ? { backgroundColor: `${tint}25`, borderColor: `${tint}80` } : undefined}
      >
        {onPick ? (
          <button
            type="button"
            onClick={onPick}
            aria-pressed={active}
            className="flex min-w-0 flex-1 items-center gap-2 focus:outline-none"
          >
            {head}
          </button>
        ) : (
          head
        )}
        {control}
      </div>
      <div
        role="presentation"
        onPointerDown={onScrub ? (event) => onScrub(event.clientX) : undefined}
        className={cn(
          "relative min-w-0 flex-1 overflow-hidden rounded-r-lg border border-white/10 bg-black/20",
          height,
          onScrub && "cursor-ew-resize",
        )}
        style={{ color: tone }}
      >
        {children}
      </div>
    </div>
  );
}

function AudioLane({
  track,
  name,
  volume,
  offset,
  duration,
  tone,
  disabled,
  clipFrom,
  clipTo,
  from,
  to,
  trimmed,
  trimming,
  onChange,
  onGrab,
  onNudge,
  onReset,
  onTrim,
  onTrimNudge,
  onTrimReset,
  t,
}: {
  track: ClipAudioTrack;
  name: string;
  volume: number;
  offset: number;
  duration: number;
  tone: string;
  disabled: boolean;
  clipFrom: number;
  clipTo: number;
  from: number;
  to: number;
  trimmed: boolean;
  trimming: "start" | "end" | null;
  onChange: (volume: number) => void;
  onGrab: (event: { clientX: number }) => void;
  onNudge: (by: number) => void;
  onReset: () => void;
  onTrim: (edge: "start" | "end") => void;
  onTrimNudge: (edge: "start" | "end", by: number) => void;
  onTrimReset: () => void;
  t: Translate;
}) {
  const muted = volume === 0;
  const shiftable = track.adjustable && !disabled;
  const span = duration > 0 ? duration : 1;
  const shift = (offset / span) * 100;
  const at = (seconds: number) => (seconds / span) * 100;

  return (
    <Lane
      icon={track.label === "Microphone" ? "solar:microphone-bold" : "solar:soundwave-bold"}
      name={name}
      tint={tone}
      tone={tone}
      height="h-12"
      control={
        track.adjustable ? (
          <div className="flex shrink-0 items-center gap-1">
            <span
              className={cn(
                "w-9 text-right font-minecraft text-[0.7rem] tabular-nums",
                volume === 100 ? "text-white/40" : "text-white",
              )}
            >
              {volume}%
            </span>
            <ClipIconButton
              icon={muted ? "solar:volume-cross-bold" : "solar:volume-loud-bold"}
              label={muted ? t("clips.trim.unmute") : t("clips.trim.mute")}
              tooltipPosition="top"
              aria-pressed={muted}
              disabled={disabled}
              onClick={() => onChange(muted ? 100 : 0)}
              className={cn("h-7 w-7", muted && "text-white/40 hover:text-white/70")}
            />
          </div>
        ) : undefined
      }
    >
      <div
        className="absolute inset-0"
        style={offset === 0 ? undefined : { transform: `translateX(${shift}%)` }}
      >
        <Waveform peaks={track.peaks} gain={volume / 100} muted={muted} />
      </div>

      {shiftable && (
        <button
          type="button"
          aria-label={t("clips.editor.audio.offset_shift", { name })}
          onPointerDown={(event) => {
            event.preventDefault();
            onGrab(event);
          }}
          onDoubleClick={onReset}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const step = event.shiftKey ? NUDGE * 10 : NUDGE;
            onNudge(event.key === "ArrowLeft" ? -step : step);
          }}
          className="absolute inset-0 cursor-grab focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60"
        />
      )}

      {shiftable && (
        <div className="pointer-events-none absolute inset-0 z-10">
          <div
            className="absolute inset-y-0 bg-black/70"
            style={{
              left: `${at(clipFrom)}%`,
              width: `${Math.max(0, at(from) - at(clipFrom))}%`,
            }}
          />
          <div
            className="absolute inset-y-0 bg-black/70"
            style={{ left: `${at(to)}%`, width: `${Math.max(0, at(clipTo) - at(to))}%` }}
          />
          <Handle
            left={at(from)}
            active={trimming === "start"}
            time={formatTime(from)}
            label={t("clips.editor.audio.trim_start", { name })}
            color={tone}
            onGrab={() => onTrim("start")}
            onNudge={(by) => onTrimNudge("start", by)}
          />
          <Handle
            left={at(to)}
            active={trimming === "end"}
            time={formatTime(to)}
            label={t("clips.editor.audio.trim_end", { name })}
            color={tone}
            onGrab={() => onTrim("end")}
            onNudge={(by) => onTrimNudge("end", by)}
          />
        </div>
      )}

      {shiftable && trimmed && (
        <button
          type="button"
          title={t("clips.editor.audio.trim_reset")}
          aria-label={t("clips.editor.audio.trim_reset")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onTrimReset}
          className="absolute left-1/2 top-1 z-20 -translate-x-1/2 rounded border border-white/20 bg-black/70 px-1.5 py-0.5 font-minecraft text-[0.7rem] tabular-nums text-white transition-colors hover:border-white/60"
        >
          {`${(to - from).toFixed(1)} s`}
        </button>
      )}

      {shiftable && offset !== 0 && (
        <button
          type="button"
          title={t("clips.editor.audio.offset_reset")}
          aria-label={t("clips.editor.audio.offset_reset")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onReset}
          className="absolute right-1 top-1 z-20 rounded border border-white/20 bg-black/70 px-1.5 py-0.5 font-minecraft text-[0.7rem] tabular-nums text-white transition-colors hover:border-white/60"
        >
          {formatOffset(offset)}
        </button>
      )}
    </Lane>
  );
}

function OverlayLane({
  overlay,
  duration,
  active,
  accent,
  name,
  onPick,
  onGrab,
}: {
  overlay: ClipOverlay;
  duration: number;
  active: boolean;
  accent: string;
  name: string;
  onPick: () => void;
  onGrab: (mode: "move" | "start" | "end", event: { clientX: number }) => void;
}) {
  const tint = overlayTint(overlay, accent);
  const span = duration > 0 ? duration : 1;
  const left = (overlay.startSeconds / span) * 100;
  const width = ((overlay.endSeconds - overlay.startSeconds) / span) * 100;

  return (
    <Lane
      icon={OVERLAY_ICON[overlay.kind]}
      name={name}
      tint={tint}
      height="h-9"
      active={active}
      onPick={onPick}
    >
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
        className="absolute inset-y-1 flex cursor-grab items-center justify-center rounded border focus:outline-none"
        style={{
          left: `${left}%`,
          width: `${width}%`,
          borderColor: tint,
          backgroundColor: `${tint}${active ? "60" : "30"}`,
          boxShadow: active ? `0 0 10px ${tint}80` : undefined,
        }}
      >
        <span className="pointer-events-none truncate px-3 font-minecraft text-xs text-white">
          {name}
        </span>
        <span
          role="presentation"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onGrab("start", event);
          }}
          className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l bg-white/30 hover:bg-white/60"
        />
        <span
          role="presentation"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onGrab("end", event);
          }}
          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r bg-white/30 hover:bg-white/60"
        />
      </div>
    </Lane>
  );
}

function Readout({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col items-center leading-tight">
      <span
        className={cn(
          "font-minecraft tabular-nums",
          strong ? "text-base text-white" : "text-sm text-white/80",
        )}
      >
        {value}
      </span>
      <span className="font-smallcaps text-[0.65rem] uppercase tracking-wider text-white/50">
        {label}
      </span>
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
      className="group pointer-events-auto absolute inset-y-0 w-6 -translate-x-1/2 cursor-ew-resize focus:outline-none"
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
          "pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-lg bg-black/70 border border-white/10 px-1.5 py-0.5 font-minecraft text-xs text-white transition-opacity",
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
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-minecraft text-sm text-white/80">{label}</span>
        <span className="shrink-0 font-minecraft text-sm tabular-nums text-white">{value}</span>
      </div>
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
  t: Translate;
}) {
  const { showModal, hideModal } = useGlobalModal();
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
    <div className="flex flex-col gap-1.5">
      <span className="font-minecraft text-sm text-white/80">{label}</span>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          aria-label={t("clips.editor.overlay.colour.pick")}
          title={t("clips.editor.overlay.colour.pick")}
          onClick={() =>
            showModal(
              OVERLAY_COLOUR_MODAL,
              <ColorPickerModal
                initialColor={grey(value)}
                applyToTheme={false}
                onColorSelected={(picked) => accept(picked)}
                onClose={() => hideModal(OVERLAY_COLOUR_MODAL)}
              />,
              1200,
            )
          }
          className={cn(
            "h-7 w-7 shrink-0 rounded border border-white/20 transition-colors",
            disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:border-white/60",
          )}
          style={{ backgroundColor: grey(value) }}
        />

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
            "min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 font-minecraft text-sm uppercase text-white/90 outline-none transition-colors",
            disabled ? "cursor-not-allowed opacity-40" : "hover:border-white/40 focus:border-white/60",
          )}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
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
  t: Translate;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-minecraft text-sm text-white/80">{label}</span>
      <div className="grid w-fit grid-cols-2 gap-1">
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
              "flex h-7 w-7 items-center justify-center rounded-lg border transition-colors",
              value === corner.value
                ? "text-white"
                : "border-white/10 bg-black/20 text-white/50 hover:border-white/20 hover:text-white",
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
  visible,
  color,
  label,
  onPick,
  onGrab,
}: {
  overlay: ClipOverlay;
  active: boolean;
  visible: boolean;
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
        !visible && "opacity-40",
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

function overlayTint(overlay: ClipOverlay, fallback: string): string {
  return overlay.kind === "blur" ? fallback : grey(overlay.colour);
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}

function tidy(value: number): number {
  return Number(value.toFixed(2));
}

function laneWindow(
  own: LaneWindow | undefined,
  start: number,
  end: number,
): { from: number; to: number; start: number | null; end: number | null } {
  const kept = own ?? NO_WINDOW;
  const from = kept.start === null ? null : clamp(kept.start, start, end - MIN_LENGTH);
  const to = kept.end === null ? null : clamp(kept.end, (from ?? start) + MIN_LENGTH, end);
  return { from: from ?? start, to: to ?? end, start: from, end: to };
}

function formatOffset(seconds: number): string {
  return `${seconds > 0 ? "+" : "−"}${Number(Math.abs(seconds).toFixed(2))} s`;
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

function formatTick(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
