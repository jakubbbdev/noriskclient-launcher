import type { WrappedLocalStats, WrappedStats } from "../../types/wrapped";

export type WrappedPersona = "creator" | "collector" | "loyal" | "grinder" | "explorer";

export const PERSONA_ICONS: Record<WrappedPersona, string> = {
  creator: "solar:camera-bold",
  collector: "solar:t-shirt-bold",
  loyal: "solar:fire-bold",
  grinder: "solar:gamepad-bold",
  explorer: "solar:compass-bold",
};

export function pickPersona(stats: WrappedStats, local: WrappedLocalStats): WrappedPersona {
  const hours = local.playtimeSeconds / 3600;
  const scores: [WrappedPersona, number][] = [
    ["creator", stats.thisYear.mcRealPostsCreated / 20 + stats.lifetime.totalPostOfTheDays],
    ["collector", stats.lifetime.cosmeticsOwned / 30 + stats.thisYear.coinsSpent / 2000],
    ["loyal", stats.lifetime.highestLoginStreak / 30],
    ["grinder", hours / 200],
  ];
  const [persona, score] = scores.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  return score >= 1 ? persona : "explorer";
}
