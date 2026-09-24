// Set by the Tauri CLI at build time; plain comparisons let Vite fold `isMobile`
// to a constant, so desktop-only branches drop out of the mobile bundle.
const platform = import.meta.env.TAURI_ENV_PLATFORM;
export const isMobile = platform === "android" || platform === "ios";
