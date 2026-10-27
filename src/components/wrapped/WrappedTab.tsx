import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@iconify/react";
import { AnimatePresence, motion } from "framer-motion";
import { useThemeStore } from "../../store/useThemeStore";
import { useMinecraftAuthStore } from "../../store/minecraft-auth-store";
import { useProfileStore } from "../../store/profile-store";
import { getMcRealImage, getWrapped, getWrappedCommunity } from "../../services/nrc-service";
import { translateApiError } from "../../utils/nrc-error-translations";
import type { CommunityWrappedStats, WrappedLocalStats, WrappedPostHighlight, WrappedStats } from "../../types/wrapped";
import { PlayerRig } from "../launcher/PlayerRig";
import { Button } from "../ui/buttons/Button";
import type { EmoteAssetUrls } from "@noriskclient/nrc-skin-renderer/core";
import { loadLocalEmote } from "../../hooks/useIdleEmote";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { writeFile } from "@tauri-apps/plugin-fs";
import { downloadDir, join } from "@tauri-apps/api/path";
import { toast } from "sonner";
import { useActiveSkinTexture } from "../../hooks/useActiveSkinTexture";
import { useEquippedCosmetics } from "../../hooks/useEquippedCosmetics";
import { PERSONA_ICONS, pickPersona } from "./wrappedPersona";
import { renderShareCard } from "./wrappedShareCard";
import { revealItemInDir } from "../../utils/opener-utils";

type ActionState = "idle" | "busy" | "done" | "error";

const ACTION_RESET_MILLIS = 2200;

function useActionState(): [ActionState, (state: ActionState) => void] {
  const [state, setState] = useState<ActionState>("idle");
  useEffect(() => {
    if (state !== "done" && state !== "error") return;
    const timer = window.setTimeout(() => setState("idle"), ACTION_RESET_MILLIS);
    return () => window.clearTimeout(timer);
  }, [state]);
  return [state, setState];
}

function ShareActionButton({
  state,
  icon,
  label,
  doneLabel,
  primary,
  disabled,
  onClick,
}: {
  state: ActionState;
  icon: string;
  label: string;
  doneLabel: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const shownIcon =
    state === "busy" ? "solar:refresh-bold" : state === "done" ? "solar:check-circle-bold" : state === "error" ? "solar:danger-circle-bold" : icon;
  return (
    <motion.div
      key={state}
      initial={state === "done" || state === "error" ? { scale: 0.92 } : false}
      animate={state === "error" ? { scale: 1, x: [0, -6, 6, -4, 4, 0] } : { scale: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 14 }}
    >
      <Button
        variant={state === "done" ? "success" : state === "error" ? "destructive" : primary ? "3d" : "flat"}
        size="md"
        disabled={disabled || state === "busy"}
        onClick={onClick}
        icon={<Icon icon={shownIcon} className={`w-5 h-5 ${state === "busy" ? "animate-spin" : ""}`} />}
      >
        {state === "done" ? doneLabel : label}
      </Button>
    </motion.div>
  );
}

const SLIDE_MILLIS = 7000;

const SLIDE_EMOTES: Record<string, string[]> = {
  intro: ["waving", "o7"],
  member: ["kommher", "o7"],
  playtime: ["schneidersitz", "meditation", "sit"],
  streaks: ["griddy", "dab"],
  mcreal: ["overthere", "dab"],
  cosmetics: ["vibedance", "floss"],
  persona: ["worship", "o7"],
  community: ["clap", "waving"],
  outro: ["floss", "vibedance", "dab"],
};

const RIG_MASK = "linear-gradient(to right, transparent, #000 14%, #000 86%, transparent)";

const CONFETTI_COLORS = ["#ffffff", "#facc15", "#f472b6", "#60a5fa", "#4ade80"];

function Confetti() {
  const accent = useThemeStore((state) => state.accentColor.value);
  const pieces = useMemo(
    () =>
      Array.from({ length: 48 }, (_, i) => {
        const angle = Math.random() * Math.PI * 2;
        const distance = 160 + Math.random() * 260;
        return {
          id: i,
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance * 0.7 + 140,
          rotate: Math.random() * 720 - 360,
          size: 6 + Math.random() * 8,
          delay: Math.random() * 0.15,
          color: i % 3 === 0 ? accent : CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        };
      }),
    [accent],
  );
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center">
      {pieces.map((piece) => (
        <motion.span
          key={piece.id}
          className="absolute rounded-[2px]"
          style={{ width: piece.size, height: piece.size * 0.6, backgroundColor: piece.color }}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 0.4 }}
          animate={{ x: piece.x, y: piece.y, opacity: 0, rotate: piece.rotate, scale: 1 }}
          transition={{ duration: 1.8, delay: 0.35 + piece.delay, ease: [0.15, 0.7, 0.4, 1] }}
        />
      ))}
    </div>
  );
}

interface Slide {
  id: string;
  render: () => ReactNode;
}

interface StatItem {
  icon: string;
  label: string;
  value: string;
}

const COUNT_UP_MILLIS = 1400;

function useCountUp(target: number): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / COUNT_UP_MILLIS);
      setValue(Math.round(target * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    setValue(0);
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

function useAccentGradient(): CSSProperties {
  const accent = useThemeStore((state) => state.accentColor);
  return {
    backgroundImage: `linear-gradient(180deg, #ffffff 0%, ${accent.light} 38%, ${accent.value} 72%, ${accent.hoverValue} 100%)`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
    filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.55))",
  };
}

function BigNumber({ value, suffix }: { value: number; suffix?: string }) {
  const { i18n } = useTranslation();
  const gradient = useAccentGradient();
  const shown = useCountUp(value);
  const digits = value.toLocaleString(i18n.language).length;
  const size = digits <= 4 ? "text-[7.5rem]" : digits <= 6 ? "text-[6rem]" : "text-[4.5rem]";
  return (
    <div className="flex flex-col items-center gap-1">
      <span className={`font-minecraft ${size} leading-none tabular-nums pb-2`} style={gradient}>
        {shown.toLocaleString(i18n.language)}
      </span>
      {suffix && <span className="font-minecraft text-3xl text-white/80 text-shadow-lg">{suffix}</span>}
    </div>
  );
}

function StatRow({ items }: { items: StatItem[] }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-y-4">
      {items.map((item, i) => (
        <Fragment key={item.label}>
          {i > 0 && <div className="w-px h-12 bg-white/20 mx-7" />}
          <div className="flex flex-col items-center gap-1.5 min-w-0 text-shadow">
            <div className="flex items-center gap-2">
              <Icon icon={item.icon} className="w-6 h-6 text-white/60 shrink-0" />
              <span className="font-minecraft text-2xl leading-none truncate max-w-[240px]">{item.value}</span>
            </div>
            <span className="font-smallcaps text-base text-white/55 truncate max-w-[240px]">{item.label}</span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function SlideBody({ kicker, title, children }: { kicker?: string; title: string; children?: ReactNode }) {
  const appear = (delay: number) => ({
    initial: { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    transition: { delay, duration: 0.45, ease: "easeOut" as const },
  });
  return (
    <div className="flex flex-col items-center text-center gap-8 w-full">
      <div className="flex flex-col items-center gap-2">
        {kicker && (
          <motion.div {...appear(0.05)} className="font-smallcaps text-xl tracking-wide text-white/55 text-shadow">
            {kicker}
          </motion.div>
        )}
        <motion.h2 {...appear(0.15)} className="font-minecraft text-5xl text-white text-shadow-lg leading-tight">
          {title}
        </motion.h2>
      </div>
      <motion.div {...appear(0.35)} className="flex flex-col items-center gap-8 w-full">
        {children}
      </motion.div>
    </div>
  );
}

function McRealPhoto({ post }: { post: WrappedPostHighlight }) {
  const { t, i18n } = useTranslation();
  const [primary, setPrimary] = useState<string | null>(null);
  const [secondary, setSecondary] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    getMcRealImage(post._id, "primary")
      .then((url) => alive && setPrimary(url))
      .catch(() => alive && setFailed(true));
    getMcRealImage(post._id, "secondary")
      .then((url) => alive && setSecondary(url))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [post._id]);

  if (failed) return null;

  return (
    <motion.div
      className="relative w-[360px] max-w-full shrink-0 aspect-video rounded-2xl overflow-hidden ring-2 ring-white/25 shadow-[0_20px_50px_rgba(0,0,0,0.6)] bg-black/30"
      initial={{ rotate: -6, scale: 0.85, opacity: 0 }}
      animate={{ rotate: -2, scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 90, damping: 14, delay: 0.3 }}
    >
      {primary ? (
        <img src={primary} alt="" className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <div className="absolute inset-0 animate-pulse bg-white/10" />
      )}
      {secondary && (
        <img
          src={secondary}
          alt=""
          className="absolute top-3 left-3 w-1/4 aspect-video object-cover rounded-lg ring-2 ring-black/70 shadow-lg"
        />
      )}
      <div className="absolute top-3 right-3 flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1 font-minecraft text-sm">
        <Icon icon="solar:crown-bold" className="w-4 h-4 text-yellow-400" />
        {t("wrapped.mcreal.top_badge")}
      </div>
      <div className="absolute inset-x-0 bottom-0 px-4 pb-3 pt-10 bg-gradient-to-t from-black/80 to-transparent flex items-end justify-between gap-3 text-left">
        <div className="min-w-0">
          <div className="font-minecraft text-lg truncate">{post.title?.trim() || t("wrapped.mcreal.untitled")}</div>
          <div className="text-xs text-white/60">
            {new Date(post.uploadTimestamp).toLocaleDateString(i18n.language, { day: "numeric", month: "long" })}
          </div>
        </div>
        <span className="flex items-center gap-1.5 font-minecraft text-lg shrink-0">
          <Icon icon="solar:heart-bold" className="w-5 h-5 text-red-400" />
          {post.likes.toLocaleString(i18n.language)}
        </span>
      </div>
    </motion.div>
  );
}

function formatHours(seconds: number): number {
  return Math.round(seconds / 3600);
}

export function WrappedTab() {
  const { t, i18n } = useTranslation();
  const accent = useThemeStore((state) => state.accentColor.value);
  const account = useMinecraftAuthStore((state) => state.activeAccount);
  const profiles = useProfileStore((state) => state.profiles);

  const [stats, setStats] = useState<WrappedStats | null>(null);
  const [community, setCommunity] = useState<CommunityWrappedStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [slideEmotes, setSlideEmotes] = useState<Record<string, EmoteAssetUrls>>({});

  useEffect(() => {
    let alive = true;
    Promise.all(
      Object.entries(SLIDE_EMOTES).map(async ([id, slugs]) => [id, await loadLocalEmote(slugs)] as const),
    ).then((entries) => {
      if (!alive) return;
      setSlideEmotes(
        Object.fromEntries(entries.filter((entry): entry is readonly [string, EmoteAssetUrls] => entry[1] !== null)),
      );
    });
    return () => {
      alive = false;
    };
  }, []);


  const load = useCallback(() => {
    setError(null);
    getWrapped()
      .then(setStats)
      .catch((err) => setError(translateApiError(err)));
    getWrappedCommunity()
      .then(setCommunity)
      .catch(() => setCommunity(null));
  }, []);

  useEffect(load, [load]);

  const local = useMemo<WrappedLocalStats>(() => {
    const played = profiles.filter((profile) => (profile.playtime_seconds ?? 0) > 0);
    const favorite = played.reduce<(typeof played)[number] | null>(
      (best, profile) => (!best || (profile.playtime_seconds ?? 0) > (best.playtime_seconds ?? 0) ? profile : best),
      null,
    );
    return {
      playtimeSeconds: played.reduce((sum, profile) => sum + (profile.playtime_seconds ?? 0), 0),
      favoriteProfile: favorite
        ? { name: favorite.name, playtimeSeconds: favorite.playtime_seconds ?? 0, version: favorite.game_version }
        : null,
    };
  }, [profiles]);

  const name = account?.minecraft_username ?? account?.username ?? "";
  const number = (value: number) => value.toLocaleString(i18n.language);

  const accentColor = useThemeStore((state) => state.accentColor);
  const { textureUrl, variant } = useActiveSkinTexture();
  const { cosmetics: equippedCosmetics } = useEquippedCosmetics(account?.id);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareBytes, setShareBytes] = useState<Uint8Array | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  useEffect(() => () => {
    if (shareUrl) URL.revokeObjectURL(shareUrl);
  }, [shareUrl]);

  const openShare = useCallback(() => {
    setShareOpen(true);
    if (!stats || shareBytes) return;
    const cardStats = [
      local.playtimeSeconds >= 3600 && { value: number(formatHours(local.playtimeSeconds)), label: t("wrapped.playtime.hours") },
      stats.thisYear.mcRealPostsCreated > 0 && { value: number(stats.thisYear.mcRealPostsCreated), label: t("wrapped.mcreal.posts_year", { year: stats.year }) },
      stats.lifetime.cosmeticsOwned > 0 && { value: number(stats.lifetime.cosmeticsOwned), label: t("wrapped.cosmetics.items") },
      stats.lifetime.highestLoginStreak > 0 && { value: number(stats.lifetime.highestLoginStreak), label: t("wrapped.streaks.login") },
      stats.thisYear.coinsSpent > 0 && { value: number(stats.thisYear.coinsSpent), label: t("wrapped.cosmetics.coins", { year: stats.year }) },
    ].filter((stat): stat is { value: string; label: string } => !!stat);
    renderShareCard({
      year: stats.year,
      name,
      persona: t(`wrapped.persona.${pickPersona(stats, local)}.title`),
      accent: accentColor,
      skin: textureUrl
        ? {
            textureUrl,
            variant,
            cosmetics: equippedCosmetics.map((c) => ({ id: c.cosmeticId, type: c.type, urls: c.urls })),
          }
        : null,
      stats: cardStats,
    })
      .then((bytes) => {
        setShareBytes(bytes);
        setShareUrl(URL.createObjectURL(new Blob([bytes], { type: "image/png" })));
      })
      .catch((err) => {
        console.error("Failed to render the Wrapped share card:", err);
        toast.error(t("wrapped.share.failed"));
        setShareOpen(false);
      });
  }, [stats, shareBytes, local, name, accentColor, textureUrl, variant, equippedCosmetics, t, i18n.language]);

  const [copyState, setCopyState] = useActionState();
  const [saveState, setSaveState] = useActionState();

  const copyShare = async () => {
    if (!shareBytes) return;
    setCopyState("busy");
    try {
      await writeImage(shareBytes);
      setCopyState("done");
      toast.success(t("wrapped.share.copied"));
    } catch (err) {
      console.error("Failed to copy the Wrapped share card:", err);
      setCopyState("error");
      toast.error(t("wrapped.share.failed"));
    }
  };

  const saveShare = async () => {
    if (!shareBytes || !stats) return;
    setSaveState("busy");
    try {
      const path = await join(await downloadDir(), `NoRisk-Wrapped-${stats.year}.png`);
      await writeFile(path, shareBytes);
      setSaveState("done");
      toast.success(t("wrapped.share.saved"), {
        action: { label: t("wrapped.share.open_folder"), onClick: () => void revealItemInDir(path) },
      });
    } catch (err) {
      console.error("Failed to save the Wrapped share card:", err);
      setSaveState("error");
      toast.error(t("wrapped.share.failed"));
    }
  };

  const slides = useMemo<Slide[]>(() => {
    if (!stats) return [];
    const list: Slide[] = [];
    const year = stats.year;
    const memberSince = stats.lifetime.memberSince > 0 ? new Date(stats.lifetime.memberSince) : null;

    list.push({
      id: "intro",
      render: () => (
        <SlideBody kicker={t("wrapped.intro.kicker", { year })} title={t("wrapped.intro.title", { name })}>
          <p className="text-2xl text-white/75 text-shadow max-w-lg">{t("wrapped.intro.subtitle")}</p>
        </SlideBody>
      ),
    });

    if (memberSince) {
      const days = Math.max(1, Math.floor((Date.now() - memberSince.getTime()) / 86_400_000));
      list.push({
        id: "member",
        render: () => (
          <SlideBody kicker={t("wrapped.member.kicker")} title={t("wrapped.member.title", { date: memberSince.toLocaleDateString(i18n.language) })}>
            <BigNumber value={days} suffix={t("wrapped.member.days")} />
            <p className="text-xl text-white/65 text-shadow">{t("wrapped.member.subtitle")}</p>
          </SlideBody>
        ),
      });
    }

    if (local.playtimeSeconds >= 3600) {
      list.push({
        id: "playtime",
        render: () => (
          <SlideBody kicker={t("wrapped.playtime.kicker")} title={t("wrapped.playtime.title")}>
            <BigNumber value={formatHours(local.playtimeSeconds)} suffix={t("wrapped.playtime.hours")} />
            {local.favoriteProfile && (
              <StatRow
                items={[
                  {
                    icon: "solar:star-bold",
                    label: t("wrapped.playtime.favorite", { version: local.favoriteProfile.version }),
                    value: `${local.favoriteProfile.name} · ${number(formatHours(local.favoriteProfile.playtimeSeconds))}h`,
                  },
                ]}
              />
            )}
          </SlideBody>
        ),
      });
    }

    if (stats.lifetime.highestLoginStreak > 0 || stats.lifetime.highestMcRealStreak > 0 || stats.lifetime.totalPostOfTheDays > 0) {
      list.push({
        id: "streaks",
        render: () => (
          <SlideBody kicker={t("wrapped.streaks.kicker")} title={t("wrapped.streaks.title")}>
            <BigNumber value={stats.lifetime.highestLoginStreak} suffix={t("wrapped.streaks.days")} />
            <StatRow
              items={[
                { icon: "solar:calendar-bold", label: t("wrapped.streaks.login"), value: number(stats.lifetime.highestLoginStreak) },
                { icon: "solar:camera-bold", label: t("wrapped.streaks.mcreal"), value: number(stats.lifetime.highestMcRealStreak) },
                ...(stats.lifetime.totalPostOfTheDays > 0
                  ? [{ icon: "solar:cup-star-bold", label: t("wrapped.mcreal.potd"), value: number(stats.lifetime.totalPostOfTheDays) }]
                  : []),
              ]}
            />
            <p className="font-smallcaps text-base text-white/45 text-shadow">{t("wrapped.streaks.alltime")}</p>
          </SlideBody>
        ),
      });
    }

    if (stats.thisYear.mcRealPostsCreated > 0 || stats.thisYear.mcRealCommentsWritten > 0) {
      const top = stats.thisYear.topPosts[0];
      const details: StatItem[] = [
        { icon: "solar:chat-round-dots-bold", label: t("wrapped.mcreal.comments"), value: number(stats.thisYear.mcRealCommentsWritten) },
      ];
      const posts = <BigNumber value={stats.thisYear.mcRealPostsCreated} suffix={t("wrapped.mcreal.posts_year", { year })} />;
      list.push({
        id: "mcreal",
        render: () => (
          <SlideBody kicker={t("wrapped.mcreal.kicker", { year })} title={t("wrapped.mcreal.title")}>
            {top ? (
              <div className="flex items-center justify-center gap-10">
                <McRealPhoto post={top} />
                <div className="flex flex-col items-start gap-5">
                  {posts}
                  {details.map((item) => (
                    <div key={item.label} className="flex items-center gap-3 text-shadow">
                      <Icon icon={item.icon} className="w-6 h-6 text-white/60 shrink-0" />
                      <span className="font-minecraft text-2xl leading-none">{item.value}</span>
                      <span className="font-smallcaps text-base text-white/55">{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {posts}
                <StatRow items={details} />
              </>
            )}
          </SlideBody>
        ),
      });
    }

    if (stats.lifetime.cosmeticsOwned > 0 || stats.thisYear.coinsSpent > 0) {
      list.push({
        id: "cosmetics",
        render: () => (
          <SlideBody kicker={t("wrapped.cosmetics.kicker")} title={t("wrapped.cosmetics.title")}>
            <BigNumber value={stats.lifetime.cosmeticsOwned} suffix={t("wrapped.cosmetics.items")} />
            {stats.thisYear.coinsSpent > 0 && (
              <StatRow items={[{ icon: "solar:wallet-money-bold", label: t("wrapped.cosmetics.coins", { year }), value: number(stats.thisYear.coinsSpent) }]} />
            )}
          </SlideBody>
        ),
      });
    }

    const persona = pickPersona(stats, local);
    list.push({
      id: "persona",
      render: () => (
        <SlideBody kicker={t("wrapped.persona.kicker")} title={t(`wrapped.persona.${persona}.title`)}>
          <Confetti />
          <motion.div
            initial={{ rotate: -90, scale: 0 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 90, delay: 0.3 }}
          >
            <Icon icon={PERSONA_ICONS[persona]} className="w-32 h-32 drop-shadow-[0_6px_10px_rgba(0,0,0,0.6)]" style={{ color: accent }} />
          </motion.div>
          <p className="text-2xl text-white/75 text-shadow max-w-lg">{t(`wrapped.persona.${persona}.text`)}</p>
        </SlideBody>
      ),
    });

    if (community) {
      list.push({
        id: "community",
        render: () => (
          <SlideBody kicker={t("wrapped.community.kicker", { year: community.year })} title={t("wrapped.community.title")}>
            <BigNumber value={community.newPlayers} suffix={t("wrapped.community.players")} />
            <StatRow
              items={[
                { icon: "solar:camera-bold", label: t("wrapped.community.posts"), value: number(community.mcRealPosts) },
                { icon: "solar:heart-bold", label: t("wrapped.community.likes"), value: number(community.mcRealLikes) },
                { icon: "solar:wallet-money-bold", label: t("wrapped.community.coins"), value: number(community.coinsSpent) },
                { icon: "solar:hanger-bold", label: t("wrapped.community.capes"), value: number(community.capesAccepted) },
              ]}
            />
          </SlideBody>
        ),
      });
    }

    list.push({
      id: "outro",
      render: () => (
        <SlideBody kicker={t("wrapped.outro.kicker", { year })} title={t("wrapped.outro.title", { name })}>
          <Confetti />
          <StatRow
            items={[
              ...(local.playtimeSeconds >= 3600
                ? [{ icon: "solar:clock-circle-bold", label: t("wrapped.playtime.hours"), value: number(formatHours(local.playtimeSeconds)) }]
                : []),
              { icon: "solar:t-shirt-bold", label: t("wrapped.cosmetics.items"), value: number(stats.lifetime.cosmeticsOwned) },
              { icon: "solar:camera-bold", label: t("wrapped.mcreal.posts"), value: number(stats.thisYear.mcRealPostsCreated) },
              { icon: PERSONA_ICONS[persona], label: t("wrapped.persona.kicker"), value: t(`wrapped.persona.${persona}.title`) },
            ]}
          />
          <div className="flex items-center gap-3">
            <Button
              variant="3d"
              size="md"
              onClick={(event) => {
                event.stopPropagation();
                openShare();
              }}
              icon={<Icon icon="solar:share-bold" className="w-5 h-5" />}>
              {t("wrapped.share.button")}
            </Button>
            <Button
              variant="flat"
              size="md"
              onClick={(event) => {
                event.stopPropagation();
                setIndex(0);
              }}
              icon={<Icon icon="solar:restart-bold" className="w-5 h-5" />}>
              {t("wrapped.outro.replay")}
            </Button>
          </div>
        </SlideBody>
      ),
    });

    return list;
  }, [stats, community, local, name, accent, openShare, t, i18n.language]);

  const last = slides.length - 1;
  const next = useCallback(() => setIndex((current) => Math.min(current + 1, last)), [last]);
  const previous = useCallback(() => setIndex((current) => Math.max(current - 1, 0)), []);


  const slideId = started ? slides[index]?.id : undefined;
  const rigEmote = (slideId ? slideEmotes[slideId] : undefined) ?? null;
  const gradient = useAccentGradient();

  useEffect(() => {
    if (!started || paused || index >= last) return;
    const timer = window.setTimeout(next, SLIDE_MILLIS);
    return () => window.clearTimeout(timer);
  }, [started, paused, index, last, next]);

  useEffect(() => {
    if (!started) return;
    const onKey = (event: KeyboardEvent) => {
      if (shareOpen) {
        if (event.key === "Escape") setShareOpen(false);
        return;
      }
      if (event.key === "ArrowRight" || event.key === " ") next();
      if (event.key === "ArrowLeft") previous();
      if (event.key === "Escape") setStarted(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started, shareOpen, next, previous]);

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-6 text-center">
        <Icon icon="solar:sad-circle-bold" className="w-12 h-12 text-white/60" />
        <p className="text-white/80 max-w-md text-shadow">{error}</p>
        <Button variant="flat" onClick={load}>
          {t("wrapped.retry")}
        </Button>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="h-full flex items-center justify-center">
        <Icon icon="solar:refresh-bold" className="w-10 h-10 animate-spin text-white/60" />
      </div>
    );
  }

  const navButton = "text-white/45 hover:text-white disabled:opacity-20 disabled:hover:text-white/45 transition-colors";

  return (
    <div className="relative h-full flex flex-col select-none overflow-hidden">
      <div className="relative z-20 h-14 shrink-0 flex items-end justify-center px-10">
        {started && (
          <div className="w-full max-w-4xl flex items-center gap-4">
            <div className="flex-1 flex gap-1.5">
              {slides.map((slide, i) => (
                <button
                  key={slide.id}
                  type="button"
                  onClick={() => setIndex(i)}
                  className="h-1 flex-1 rounded-full bg-white/20 overflow-hidden"
                  aria-label={`${i + 1}`}
                >
                  <motion.div
                    key={`${slide.id}-${index}-${paused}`}
                    className="h-full"
                    style={{ backgroundColor: accent }}
                    initial={{ width: i < index || (i === index && index === last) ? "100%" : "0%" }}
                    animate={{ width: i < index || (i === index && (index === last || !paused)) ? "100%" : "0%" }}
                    transition={{ duration: i === index && !paused && index !== last ? SLIDE_MILLIS / 1000 : 0, ease: "linear" }}
                  />
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setStarted(false)} className={navButton} aria-label={t("wrapped.close")}>
              <Icon icon="solar:close-circle-linear" className="w-6 h-6" />
            </button>
          </div>
        )}
      </div>

      <div
        className="flex-1 min-h-0 flex items-center justify-center gap-12 px-10"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div
          className="relative z-0 hidden lg:flex shrink-0 w-[340px] h-full items-center justify-center overflow-hidden"
          style={{ maskImage: RIG_MASK, WebkitMaskImage: RIG_MASK }}
        >
          <PlayerRig playerName={name} emote={rigEmote} />
        </div>

        <div className="relative z-10 w-full max-w-[720px] h-full">
          <AnimatePresence mode="wait">
            {started ? (
              <motion.div
                key={slides[index]?.id}
                className="absolute inset-0 flex items-center justify-center cursor-pointer"
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  if (event.clientX - bounds.left < bounds.width / 3) previous();
                  else next();
                }}
                initial={{ opacity: 0, y: 24, filter: "blur(8px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -24, filter: "blur(8px)" }}
                transition={{ duration: 0.35 }}
              >
                {slides[index]?.render()}
              </motion.div>
            ) : (
              <motion.div
                key="cover"
                className="absolute inset-0 flex flex-col items-center justify-center text-center gap-3"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.04 }}
                transition={{ duration: 0.4 }}
              >
                <div className="font-smallcaps text-xl tracking-wide text-white/55 text-shadow">NoRisk Wrapped</div>
                <div className="font-minecraft text-[11rem] leading-none pb-3" style={gradient}>
                  {stats.year}
                </div>
                <div className="font-minecraft text-4xl text-white text-shadow mb-8">{t("wrapped.cover.title")}</div>
                <Button
                  variant="3d"
                  size="lg"
                  icon={<Icon icon="solar:play-bold" className="w-5 h-5" />}
                  onClick={() => {
                    setIndex(0);
                    setStarted(true);
                  }}
                >
                  {t("wrapped.cover.start")}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="relative z-20 h-16 shrink-0 flex items-start justify-center">
        {started && (
          <div className="flex items-center gap-5 font-minecraft text-white/45 text-shadow">
            <button type="button" onClick={previous} disabled={index === 0} className={navButton} aria-label={t("wrapped.previous")}>
              <Icon icon="solar:alt-arrow-left-linear" className="w-8 h-8" />
            </button>
            <span className="text-base tabular-nums w-14 text-center">
              {index + 1} / {slides.length}
            </span>
            <button type="button" onClick={next} disabled={index === last} className={navButton} aria-label={t("wrapped.next")}>
              <Icon icon="solar:alt-arrow-right-linear" className="w-8 h-8" />
            </button>
          </div>
        )}
      </div>
      <AnimatePresence>
        {shareOpen && (
          <motion.div
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setShareOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="flex flex-col items-center gap-5"
              onClick={(event) => event.stopPropagation()}
              initial={{ scale: 0.94, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.94, y: 12 }}
            >
              {shareUrl ? (
                <img src={shareUrl} alt="" className="w-[720px] max-w-[85%] rounded-xl ring-2 ring-white/20 shadow-[0_20px_60px_rgba(0,0,0,0.7)]" />
              ) : (
                <div className="w-[720px] max-w-[85%] aspect-[16/9] rounded-xl bg-white/5 ring-2 ring-white/10 flex items-center justify-center">
                  <Icon icon="solar:refresh-bold" className="w-10 h-10 animate-spin text-white/50" />
                </div>
              )}
              <div className="flex items-center gap-3">
                <ShareActionButton
                  primary
                  state={copyState}
                  icon="solar:copy-bold"
                  label={t("wrapped.share.copy")}
                  doneLabel={t("wrapped.share.copied_short")}
                  disabled={!shareBytes}
                  onClick={copyShare}
                />
                <ShareActionButton
                  state={saveState}
                  icon="solar:download-minimalistic-bold"
                  label={t("wrapped.share.save")}
                  doneLabel={t("wrapped.share.saved_short")}
                  disabled={!shareBytes}
                  onClick={saveShare}
                />
                <Button variant="flat" size="md" onClick={() => setShareOpen(false)}>
                  {t("wrapped.close")}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
