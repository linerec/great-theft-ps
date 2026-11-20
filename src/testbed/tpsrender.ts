// SPDX-License-Identifier: AGPL-3.0-only
//
// Small software 3D renderer for the third-person test bed: perspective projection of boxes with
// near-plane clipping and back-face culling, painted far to near. No dependencies, runs on a 2D canvas.

import { BUILDINGS, WORLD_SIZE, type Rgb, type TpsGame } from './tps.ts';

const RAD = Math.PI / 180;
const NEAR = 0.15;

type Vec = [number, number, number];

interface Face {
  verts: Vec[];
  normal: Vec;
  color: Rgb;
}

interface Drawable {
  center: Vec;
  faces: Face[];
}

/** Six faces of a box whose local X is the heading and local Z is to the right of it. */
function box(cx: number, cy: number, cz: number, lx: number, ly: number, lz: number, headingDeg: number, color: Rgb): Drawable {
  const h = headingDeg * RAD;
  const fx = Math.cos(h);
  const fz = Math.sin(h);
  const rx = -fz;
  const rz = fx;
  const corner = (a: number, b: number, c: number): Vec => [
    cx + fx * a * lx * 0.5 + rx * c * lz * 0.5,
    cy + b * ly * 0.5,
    cz + fz * a * lx * 0.5 + rz * c * lz * 0.5,
  ];
  const f = (verts: Vec[], normal: Vec): Face => ({ verts, normal, color });
  return {
    center: [cx, cy, cz],
    faces: [
      f([corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(1, -1, 1)], [fx, 0, fz]),
      f([corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1), corner(-1, -1, -1)], [-fx, 0, -fz]),
      f([corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1), corner(-1, -1, 1)], [rx, 0, rz]),
      f([corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1), corner(1, -1, -1)], [-rx, 0, -rz]),
      f([corner(-1, 1, -1), corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1)], [0, 1, 0]),
    ],
  };
}

interface View {
  w: number;
  h: number;
  focal: number;
  cam: Vec;
  fwd: Vec;
  right: Vec;
  up: Vec;
}

/** World point to camera space: x right, y up, z forward. */
function toCamera(v: View, p: Vec): Vec {
  const rx = p[0] - v.cam[0];
  const ry = p[1] - v.cam[1];
  const rz = p[2] - v.cam[2];
  return [
    rx * v.right[0] + ry * v.right[1] + rz * v.right[2],
    rx * v.up[0] + ry * v.up[1] + rz * v.up[2],
    rx * v.fwd[0] + ry * v.fwd[1] + rz * v.fwd[2],
  ];
}

/** Clip a camera-space polygon against the near plane. */
function clipNear(poly: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const aIn = a[2] >= NEAR;
    const bIn = b[2] >= NEAR;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (NEAR - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
    }
  }
  return out;
}

function fillPoly(ctx: CanvasRenderingContext2D, v: View, poly: Vec[], fill: string, stroke?: string): void {
  const clipped = clipNear(poly);
  if (clipped.length < 3) return;
  ctx.beginPath();
  clipped.forEach((p, i) => {
    const sx = v.w / 2 + (p[0] / p[2]) * v.focal;
    const sy = v.h / 2 - (p[1] / p[2]) * v.focal;
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

const LIGHT: Vec = [0.45, 0.8, 0.4];

function shaded(color: Rgb, normal: Vec, dist: number): string {
  const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const lambert = Math.max(0, (normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2]) / len);
  const fog = Math.max(0.35, 1 / (1 + dist * 0.012));
  const k = (0.45 + 0.55 * lambert) * fog;
  return `rgb(${Math.round(color[0] * k)},${Math.round(color[1] * k)},${Math.round(color[2] * k)})`;
}

function scene(game: TpsGame): Drawable[] {
  const out: Drawable[] = [];
  for (const b of BUILDINGS) {
    out.push(box((b.x0 + b.x1) / 2, b.h / 2, (b.z0 + b.z1) / 2, b.x1 - b.x0, b.h, b.z1 - b.z0, 0, b.color));
  }
  for (const t of game.targets) {
    if (t.respawn > 0) continue;
    const color: Rgb = t.flash > 0 ? [255, 255, 255] : [214, 48, 48];
    out.push(box(t.x, 1.0, t.z, 0.9, 2.0, 0.9, 0, color));
    if (t.flash <= 0) out.push(box(t.x, 1.3, t.z, 0.95, 0.5, 0.95, 0, [244, 244, 244]));
  }
  // Car: body, cabin, wheels.
  const c = game.car;
  out.push(box(c.x, 0.65, c.z, 4.2, 0.7, 1.8, c.heading, [196, 40, 52]));
  out.push(box(c.x - Math.cos(c.heading * RAD) * 0.2, 1.3, c.z - Math.sin(c.heading * RAD) * 0.2, 2.2, 0.6, 1.6, c.heading, [150, 190, 220]));
  if (!game.inVehicle) {
    // Character: legs, torso, head and, when aiming, a gun.
    const h = game.heading;
    const y = game.y;
    out.push(box(game.x, y + 0.45, game.z, 0.4, 0.9, 0.5, h, [48, 52, 66]));
    out.push(box(game.x, y + 1.25, game.z, 0.4, 0.7, 0.6, h, [232, 150, 40]));
    out.push(box(game.x, y + 1.78, game.z, 0.32, 0.32, 0.32, h, [226, 188, 150]));
    if (game.aimAmount > 0.3) {
      const r = (game.yaw + 90) * RAD;
      out.push(box(game.x + Math.cos(r) * 0.3 + Math.cos(game.yaw * RAD) * 0.5, y + 1.35, game.z + Math.sin(r) * 0.3 + Math.sin(game.yaw * RAD) * 0.5, 0.9, 0.16, 0.14, game.yaw, [30, 32, 38]));
    }
  }
  return out;
}

export function renderTps(ctx: CanvasRenderingContext2D, game: TpsGame, w: number, h: number): void {
  const pose = game.cameraPose();
  const cp = Math.cos(pose.pitch * RAD);
  const sp = Math.sin(pose.pitch * RAD);
  const cy = Math.cos(pose.yaw * RAD);
  const sy = Math.sin(pose.yaw * RAD);
  const v: View = {
    w,
    h,
    focal: w / 2 / Math.tan((pose.fov * RAD) / 2),
    cam: [pose.x, pose.y, pose.z],
    fwd: [cp * cy, sp, cp * sy],
    right: [-sy, 0, cy],
    up: [-sp * cy, cp, -sp * sy],
  };

  // Sky above the horizon line, ground below it.
  const horizon = Math.round(h / 2 + (sp / cp) * v.focal);
  const skyEnd = Math.max(1, Math.min(h, horizon));
  const sky = ctx.createLinearGradient(0, 0, 0, skyEnd);
  sky.addColorStop(0, '#1f3358');
  sky.addColorStop(1, '#8db4dc');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  if (horizon < h) {
    const ground = ctx.createLinearGradient(0, Math.max(0, horizon), 0, h);
    ground.addColorStop(0, '#6f8f62');
    ground.addColorStop(1, '#3f5a3c');
    ctx.fillStyle = ground;
    ctx.fillRect(0, Math.max(0, horizon), w, h - Math.max(0, horizon));
  }

  // Roads: a cross through the middle of the arena, flat on the ground.
  const road = (x0: number, z0: number, x1: number, z1: number): void => {
    const quad: Vec[] = [
      toCamera(v, [x0, 0.01, z0]),
      toCamera(v, [x1, 0.01, z0]),
      toCamera(v, [x1, 0.01, z1]),
      toCamera(v, [x0, 0.01, z1]),
    ];
    fillPoly(ctx, v, quad, '#3b3f46');
  };
  road(36, 0, 44, WORLD_SIZE);
  road(0, 36, WORLD_SIZE, 44);
  // Lane marks.
  for (let t = 0; t < WORLD_SIZE; t += 4) {
    const mark = (x0: number, z0: number, x1: number, z1: number): void =>
      fillPoly(ctx, v, [toCamera(v, [x0, 0.02, z0]), toCamera(v, [x1, 0.02, z0]), toCamera(v, [x1, 0.02, z1]), toCamera(v, [x0, 0.02, z1])], '#d8d8c8');
    if (t < 34 || t > 44) mark(39.9, t, 40.1, t + 1.6);
    if (t < 34 || t > 44) mark(t, 39.9, t + 1.6, 40.1);
  }

  // Everything else, far to near, with back faces culled.
  const drawables = scene(game)
    .map((d) => ({ d, dist: Math.hypot(d.center[0] - pose.x, d.center[1] - pose.y, d.center[2] - pose.z) }))
    .sort((a, b) => b.dist - a.dist);
  for (const { d, dist } of drawables) {
    const faces = d.faces
      .map((f) => {
        const mid: Vec = [0, 0, 0];
        for (const p of f.verts) {
          mid[0] += p[0] / f.verts.length;
          mid[1] += p[1] / f.verts.length;
          mid[2] += p[2] / f.verts.length;
        }
        const toFace: Vec = [mid[0] - pose.x, mid[1] - pose.y, mid[2] - pose.z];
        const facing = f.normal[0] * toFace[0] + f.normal[1] * toFace[1] + f.normal[2] * toFace[2];
        return { f, facing, depth: Math.hypot(toFace[0], toFace[1], toFace[2]) };
      })
      .filter((x) => x.facing < 0)
      .sort((a, b) => b.depth - a.depth);
    for (const { f } of faces) {
      fillPoly(ctx, v, f.verts.map((p) => toCamera(v, p)), shaded(f.color, f.normal, dist), 'rgba(0,0,0,0.22)');
    }
  }

  drawHud(ctx, game, w, h);
}

function drawHud(ctx: CanvasRenderingContext2D, game: TpsGame, w: number, h: number): void {
  const cx = w / 2;
  const cy = h / 2;

  // Reticle only while aiming, as in GTA.
  if (game.aimAmount > 0.4) {
    ctx.strokeStyle = game.muzzle > 0 ? '#ffe066' : 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.moveTo(cx - 12, cy);
    ctx.lineTo(cx - 7, cy);
    ctx.moveTo(cx + 7, cy);
    ctx.lineTo(cx + 12, cy);
    ctx.moveTo(cx, cy - 12);
    ctx.lineTo(cx, cy - 7);
    ctx.moveTo(cx, cy + 7);
    ctx.lineTo(cx, cy + 12);
    ctx.stroke();
    if (game.hitMarker > 0) {
      ctx.strokeStyle = '#ff5252';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - 10, cy - 10);
      ctx.lineTo(cx - 5, cy - 5);
      ctx.moveTo(cx + 10, cy - 10);
      ctx.lineTo(cx + 5, cy - 5);
      ctx.moveTo(cx - 10, cy + 10);
      ctx.lineTo(cx - 5, cy + 5);
      ctx.moveTo(cx + 10, cy + 10);
      ctx.lineTo(cx + 5, cy + 5);
      ctx.stroke();
    }
  }

  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 3;
  ctx.fillText(`${game.yaw.toFixed(0)}° ${game.heading8}`, cx, 14);
  ctx.textAlign = 'right';
  ctx.fillText(`명중 ${game.hits} / 발사 ${game.shots}`, w - 8, 14);
  ctx.textAlign = 'left';
  ctx.fillText(`${game.movementName}  ${game.speedKmh.toFixed(0)} km/h`, 8, h - 10);
  if (!game.inVehicle && game.sprintCharge > 0.02) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(8, h - 30, 80, 6);
    ctx.fillStyle = '#ffcf5a';
    ctx.fillRect(8, h - 30, 80 * game.sprintCharge, 6);
  }
  ctx.shadowBlur = 0;

  // Minimap.
  const scale = 1.4;
  const ox = w - WORLD_SIZE * scale - 8;
  const oy = 24;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(ox - 2, oy - 2, WORLD_SIZE * scale + 4, WORLD_SIZE * scale + 4);
  ctx.fillStyle = 'rgba(70,74,84,0.9)';
  ctx.fillRect(ox + 36 * scale, oy, 8 * scale, WORLD_SIZE * scale);
  ctx.fillRect(ox, oy + 36 * scale, WORLD_SIZE * scale, 8 * scale);
  for (const b of BUILDINGS) {
    ctx.fillStyle = `rgb(${b.color[0]},${b.color[1]},${b.color[2]})`;
    ctx.fillRect(ox + b.x0 * scale, oy + b.z0 * scale, (b.x1 - b.x0) * scale, (b.z1 - b.z0) * scale);
  }
  ctx.fillStyle = '#ff5252';
  for (const t of game.targets) {
    if (t.respawn <= 0) ctx.fillRect(ox + t.x * scale - 1.5, oy + t.z * scale - 1.5, 3, 3);
  }
  ctx.fillStyle = '#ff9f43';
  ctx.fillRect(ox + game.car.x * scale - 2.5, oy + game.car.z * scale - 2.5, 5, 5);
  const px = ox + (game.inVehicle ? game.car.x : game.x) * scale;
  const pz = oy + (game.inVehicle ? game.car.z : game.z) * scale;
  const yaw = game.yaw * RAD;
  ctx.fillStyle = 'rgba(94,234,212,0.25)';
  ctx.beginPath();
  ctx.moveTo(px, pz);
  ctx.arc(px, pz, 22, yaw - 0.6, yaw + 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#5eead4';
  ctx.beginPath();
  ctx.arc(px, pz, 2.4, 0, Math.PI * 2);
  ctx.fill();
}
