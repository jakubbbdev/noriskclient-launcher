import { invoke } from "@tauri-apps/api/core";
import { isMobile } from "../lib/platform";

export function setDiscordState(state: string) {
  // Discord Rich Presence only exists on desktop
  if (isMobile) return;
  invoke("set_discord_state", { stateType: state }).catch(() => {});
}
