import {
  SkinSnapshotRenderer,
  type SkinSnapshotRequest,
  type SnapshotCosmetic,
} from "@noriskclient/nrc-skin-renderer/snapshot";

export interface ShareCardInput {
  year: number;
  name: string;
  persona: string;
  accent: { value: string; light: string };
  skin: { textureUrl: string; variant?: SkinSnapshotRequest["variant"]; cosmetics: SnapshotCosmetic[] } | null;
  stats: { value: string; label: string }[];
}

const WIDTH = 1920;
const HEIGHT = 1080;
const SKIN_BOX = { centerX: 520, bottom: 990, width: 720, height: 900 };
const COLUMN_X = 1020;
const COLUMN_WIDTH = 780;
const POSE_EMOTE = "/emotes/launcheridle3.animation.json";
const MINECRAFT = '"MinecraftTen"';
const SMALLCAPS = '"SmallCaps"';

async function renderSkin(skin: NonNullable<ShareCardInput["skin"]>): Promise<ImageBitmap> {
  const renderer = new SkinSnapshotRenderer(SKIN_BOX.width, SKIN_BOX.height);
  try {
    const blob = await renderer.snapshot({
      textureUrl: skin.textureUrl,
      variant: skin.variant,
      cosmetics: skin.cosmetics,
      emote: { animation: POSE_EMOTE },
      emoteTime: 2,
      fit: 1.04,
      crop: 0.02,
    });
    return await createImageBitmap(blob);
  } finally {
    renderer.dispose();
  }
}

function setFont(ctx: CanvasRenderingContext2D, size: number, family: string, maxWidth = Infinity, text = "") {
  let current = size;
  ctx.font = `${current}px ${family}`;
  while (current > 14 && ctx.measureText(text).width > maxWidth) {
    current -= 2;
    ctx.font = `${current}px ${family}`;
  }
  return current;
}

function textBox(ctx: CanvasRenderingContext2D, text: string) {
  const metrics = ctx.measureText(text);
  return { width: metrics.width, ascent: metrics.actualBoundingBoxAscent, descent: metrics.actualBoundingBoxDescent };
}

function drawBackground(ctx: CanvasRenderingContext2D, accent: string) {
  const base = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  base.addColorStop(0, "#14141f");
  base.addColorStop(1, "#06060a");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glow = ctx.createRadialGradient(SKIN_BOX.centerX, 560, 0, SKIN_BOX.centerX, 560, 640);
  glow.addColorStop(0, `${accent}70`);
  glow.addColorStop(0.55, `${accent}22`);
  glow.addColorStop(1, `${accent}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const corner = ctx.createRadialGradient(WIDTH, 0, 0, WIDTH, 0, 900);
  corner.addColorStop(0, `${accent}2e`);
  corner.addColorStop(1, `${accent}00`);
  ctx.fillStyle = corner;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const vignette = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, HEIGHT * 0.45, WIDTH / 2, HEIGHT / 2, WIDTH * 0.75);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(36, 36, WIDTH - 72, HEIGHT - 72, 28);
  ctx.stroke();
}

function drawSkin(ctx: CanvasRenderingContext2D, skin: ImageBitmap) {
  const scale = Math.min(SKIN_BOX.width / skin.width, SKIN_BOX.height / skin.height);
  const w = skin.width * scale;
  const h = skin.height * scale;

  const floor = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  floor.addColorStop(0, "rgba(0,0,0,0.55)");
  floor.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.translate(SKIN_BOX.centerX, SKIN_BOX.bottom - 6);
  ctx.scale(w * 0.45, 34);
  ctx.fillStyle = floor;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.drawImage(skin, SKIN_BOX.centerX - w / 2, SKIN_BOX.bottom - h, w, h);
  ctx.restore();
}

function drawColumn(ctx: CanvasRenderingContext2D, input: ShareCardInput, top: number, draw: boolean): number {
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const shadow = (on: boolean) => {
    ctx.shadowColor = on ? "rgba(0,0,0,0.45)" : "transparent";
    ctx.shadowBlur = on ? 18 : 0;
    ctx.shadowOffsetY = on ? 6 : 0;
  };

  let y = top;

  setFont(ctx, 40, SMALLCAPS);
  ctx.letterSpacing = "6px";
  const header = textBox(ctx, "NoRisk Wrapped");
  y += header.ascent;
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  if (draw) ctx.fillText("NoRisk Wrapped", COLUMN_X, y);
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  if (draw) ctx.fillText("norisk.gg", COLUMN_X + COLUMN_WIDTH, y);
  ctx.textAlign = "left";
  ctx.letterSpacing = "0px";
  y += header.descent + 28;

  shadow(true);
  const yearText = String(input.year);
  setFont(ctx, 240, MINECRAFT, COLUMN_WIDTH, yearText);
  const year = textBox(ctx, yearText);
  y += year.ascent;
  const yearGradient = ctx.createLinearGradient(0, y - year.ascent, 0, y);
  yearGradient.addColorStop(0, "#ffffff");
  yearGradient.addColorStop(0.45, input.accent.light);
  yearGradient.addColorStop(1, input.accent.value);
  ctx.fillStyle = yearGradient;
  if (draw) ctx.fillText(yearText, COLUMN_X - 8, y);
  y += year.descent + 44;

  setFont(ctx, 76, MINECRAFT, COLUMN_WIDTH, input.name);
  const name = textBox(ctx, input.name);
  y += name.ascent;
  ctx.fillStyle = "#ffffff";
  if (draw) ctx.fillText(input.name, COLUMN_X, y);
  y += name.descent + 32;
  shadow(false);

  setFont(ctx, 40, MINECRAFT, COLUMN_WIDTH - 80, input.persona);
  const persona = textBox(ctx, input.persona);
  const pillHeight = 78;
  const pillWidth = persona.width + 72;
  ctx.fillStyle = `${input.accent.value}38`;
  ctx.strokeStyle = `${input.accent.value}aa`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(COLUMN_X, y, pillWidth, pillHeight, pillHeight / 2);
  if (draw) ctx.fill();
  if (draw) ctx.stroke();
  ctx.fillStyle = input.accent.light;
  if (draw) ctx.fillText(input.persona, COLUMN_X + 36, y + pillHeight / 2 + (persona.ascent - persona.descent) / 2);
  y += pillHeight;

  const stats = input.stats.slice(0, 4);
  if (stats.length > 0) {
    y += 48;
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    if (draw) ctx.fillRect(COLUMN_X, y, COLUMN_WIDTH, 2);
    y += 2 + 52;

    const cellWidth = COLUMN_WIDTH / 2;
    const valueSize = 80;
    const labelSize = 30;
    setFont(ctx, valueSize, MINECRAFT);
    const valueAscent = textBox(ctx, "0").ascent;
    const rowHeight = valueAscent + 22 + labelSize + 44;

    shadow(true);
    stats.forEach((stat, i) => {
      const x = COLUMN_X + (i % 2) * cellWidth;
      const baseline = y + Math.floor(i / 2) * rowHeight + valueAscent;
      setFont(ctx, valueSize, MINECRAFT, cellWidth - 40, stat.value);
      ctx.fillStyle = "#ffffff";
      if (draw) ctx.fillText(stat.value, x, baseline);
      setFont(ctx, labelSize, SMALLCAPS, cellWidth - 40, stat.label);
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      if (draw) ctx.fillText(stat.label, x, baseline + 22 + labelSize);
    });
    shadow(false);
    y += Math.ceil(stats.length / 2) * rowHeight - 44;
  }
  return y;
}

export async function renderShareCard(input: ShareCardInput): Promise<Uint8Array> {
  await Promise.all([document.fonts.load(`120px ${MINECRAFT}`), document.fonts.load(`40px ${SMALLCAPS}`)]);
  const skin = input.skin ? await renderSkin(input.skin).catch(() => null) : null;

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  drawBackground(ctx, input.accent.value);
  if (skin) drawSkin(ctx, skin);
  skin?.close();

  const height = drawColumn(ctx, input, 0, false);
  drawColumn(ctx, input, Math.round((HEIGHT - height) / 2), true);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("Share card export failed"))), "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
}
