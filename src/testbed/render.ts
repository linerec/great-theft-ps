// SPDX-License-Identifier: AGPL-3.0-only
//
// Raycasting renderer for the test bed. Outer walls are coloured by the compass
// direction you are looking toward (east green, south blue, west yellow, north red),
// so a full turn is visible at a glance.

import { MAP_ROWS, MAP_SIZE, type FpsGame } from './fps.ts';

const RAD = Math.PI / 180;

type Rgb = [number, number, number];
const FACE: Record<'E' | 'S' | 'W' | 'N', Rgb> = {
  E: [76, 175, 80],
  S: [66, 133, 244],
  W: [240, 200, 60],
  N: [230, 80, 70],
};
const INNER_WALL: Rgb = [150, 154, 168];

let depth = new Float32Array(0);

function shade(color: Rgb, factor: number): string {
  return `rgb(${Math.round(color[0] * factor)},${Math.round(color[1] * factor)},${Math.round(color[2] * factor)})`;
}

export function renderGame(ctx: CanvasRenderingContext2D, game: FpsGame, w: number, h: number): void {
  if (depth.length !== w) depth = new Float32Array(w);

  const tf = Math.tan((game.fov * RAD) / 2);
  const focal = w / 2 / tf;
  const horizon = Math.round(h / 2 + Math.tan(game.pitch * RAD) * focal);

  // Sky and floor.
  const sky = ctx.createLinearGradient(0, 0, 0, Math.max(1, horizon));
  sky.addColorStop(0, '#1d2740');
  sky.addColorStop(1, '#3b4a6b');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, Math.max(0, horizon));
  const floor = ctx.createLinearGradient(0, horizon, 0, h);
  floor.addColorStop(0, '#2a2e38');
  floor.addColorStop(1, '#4a505e');
  ctx.fillStyle = floor;
  ctx.fillRect(0, Math.max(0, horizon), w, h - Math.max(0, horizon));

  // Walls.
  const yawRad = game.yaw * RAD;
  const dirX = Math.cos(yawRad);
  const dirY = Math.sin(yawRad);
  const rightX = -dirY;
  const rightY = dirX;
  for (let col = 0; col < w; col++) {
    const cam = (2 * (col + 0.5)) / w - 1;
    const hit = game.castRay(dirX + rightX * tf * cam, dirY + rightY * tf * cam);
    const perp = Math.max(0.05, hit.perp);
    depth[col] = perp;
    const lineHeight = focal / perp;
    const outer = hit.mapX === 0 || hit.mapY === 0 || hit.mapX === MAP_SIZE - 1 || hit.mapY === MAP_SIZE - 1;
    const face = hit.side === 0 ? (hit.step === 1 ? 'E' : 'W') : hit.step === 1 ? 'S' : 'N';
    const base = outer ? FACE[face] : INNER_WALL;
    const factor = Math.max(0.28, 1 / (1 + perp * 0.12)) * (hit.side === 1 ? 0.82 : 1);
    ctx.fillStyle = shade(base, factor);
    ctx.fillRect(col, Math.round(horizon - lineHeight / 2), 1, Math.max(1, Math.round(lineHeight)));
  }

  // Targets as discs, hidden behind walls through the depth buffer.
  const visible = game.targets
    .filter((t) => t.respawn <= 0)
    .map((t) => {
      const relX = t.x - game.x;
      const relY = t.y - game.y;
      return { t, along: relX * dirX + relY * dirY, lateral: relX * rightX + relY * rightY };
    })
    .filter((v) => v.along > 0.15)
    .sort((a, b) => b.along - a.along);
  for (const { t, along, lateral } of visible) {
    const screenX = (w / 2) * (1 + lateral / along / tf);
    const half = (0.35 * focal) / along;
    const from = Math.max(0, Math.floor(screenX - half));
    const to = Math.min(w - 1, Math.ceil(screenX + half));
    for (let col = from; col <= to; col++) {
      if (along >= (depth[col] as number)) continue;
      const u = (col + 0.5 - screenX) / half;
      if (Math.abs(u) > 1) continue;
      const strip = (radius: number, color: string): void => {
        const k = u / radius;
        if (Math.abs(k) > 1) return;
        const halfHeight = half * radius * Math.sqrt(1 - k * k);
        ctx.fillStyle = color;
        ctx.fillRect(col, Math.round(horizon - halfHeight), 1, Math.max(1, Math.round(halfHeight * 2)));
      };
      if (t.flash > 0) {
        strip(1, '#ffffff');
      } else {
        strip(1, '#d92d2d');
        strip(0.66, '#f4f4f4');
        strip(0.33, '#d92d2d');
      }
    }
  }

  drawGun(ctx, game, w, h);
  drawHud(ctx, game, w, h);
}

function drawGun(ctx: CanvasRenderingContext2D, game: FpsGame, w: number, h: number): void {
  const x = w * (0.62 - 0.12 * game.adsAmount);
  const y = h - 54 + 10 * game.adsAmount;
  ctx.fillStyle = '#20232b';
  ctx.fillRect(x, y, 70, 60);
  ctx.fillStyle = '#323744';
  ctx.fillRect(x + 22, y - 22, 16, 30);
  if (game.muzzle > 0) {
    ctx.fillStyle = 'rgba(255, 220, 90, 0.9)';
    ctx.beginPath();
    ctx.arc(x + 30, y - 26, 12, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHud(ctx: CanvasRenderingContext2D, game: FpsGame, w: number, h: number): void {
  const cx = w / 2;
  const cy = h / 2;

  // Crosshair, a plain dot while aiming down sights.
  ctx.strokeStyle = game.muzzle > 0 ? '#ffe066' : 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (game.adsAmount > 0.5) {
    ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
  } else {
    ctx.moveTo(cx - 8, cy);
    ctx.lineTo(cx - 3, cy);
    ctx.moveTo(cx + 3, cy);
    ctx.lineTo(cx + 8, cy);
    ctx.moveTo(cx, cy - 8);
    ctx.lineTo(cx, cy - 3);
    ctx.moveTo(cx, cy + 3);
    ctx.lineTo(cx, cy + 8);
  }
  ctx.stroke();
  if (game.hitMarker > 0) {
    ctx.strokeStyle = '#ff5252';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy - 8);
    ctx.lineTo(cx - 3, cy - 3);
    ctx.moveTo(cx + 8, cy - 8);
    ctx.lineTo(cx + 3, cy - 3);
    ctx.moveTo(cx - 8, cy + 8);
    ctx.lineTo(cx - 3, cy + 3);
    ctx.moveTo(cx + 8, cy + 8);
    ctx.lineTo(cx + 3, cy + 3);
    ctx.stroke();
  }

  // Heading and score.
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(`${game.yaw.toFixed(0)}° ${game.heading}`, cx, 14);
  ctx.textAlign = 'right';
  ctx.fillText(`명중 ${game.hits} / 발사 ${game.shots}`, w - 8, 14);

  // Minimap.
  const cell = 5;
  const ox = 6;
  const oy = 6;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(ox - 2, oy - 2, MAP_SIZE * cell + 4, MAP_SIZE * cell + 4);
  ctx.fillStyle = 'rgba(210,214,224,0.85)';
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      if (MAP_ROWS[y]![x] === '#') ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
    }
  }
  ctx.fillStyle = '#ff5252';
  for (const t of game.targets) {
    if (t.respawn <= 0) ctx.fillRect(ox + t.x * cell - 1.5, oy + t.y * cell - 1.5, 3, 3);
  }
  const px = ox + game.x * cell;
  const py = oy + game.y * cell;
  const yawRad = game.yaw * RAD;
  ctx.strokeStyle = '#5eead4';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + Math.cos(yawRad) * 9, py + Math.sin(yawRad) * 9);
  ctx.stroke();
  ctx.fillStyle = '#5eead4';
  ctx.beginPath();
  ctx.arc(px, py, 2.2, 0, Math.PI * 2);
  ctx.fill();
}
