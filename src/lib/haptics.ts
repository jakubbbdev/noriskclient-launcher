import { isMobile } from "./platform";

/** Light tap feedback on phones; does nothing on desktop. */
export function tapHaptic() {
  if (!isMobile) return;
  import("@tauri-apps/plugin-haptics")
    .then((haptics) => haptics.impactFeedback("light"))
    .catch(() => {});
}
