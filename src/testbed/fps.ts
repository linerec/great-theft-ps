// SPDX-License-Identifier: AGPL-3.0-only
//
// A tiny first-person shooter used as a TEST BED for the mapping engine.
//
// It is written like a console game: it reads ONLY a VirtualPadState (sticks,
// triggers, buttons, gyro). It knows nothing about keyboards or mice. Look speed
// goes through the game's own inner deadzone, response curve and maximum turn
// rate, exactly the things a real game does between stick and camera. That makes
// it a faithful target for checking that WASD + mouse can drive a pad-only game.
//
// Conventions: map X points east, map Y points south. yaw 0 = east, positive yaw
// turns RIGHT (clockwise seen from above). Pitch is positive when looking UP.

import { BUTTON, type VirtualPadState } from '../engine/types.ts';

export interface GameSettings {
  /** Stick deflection below which nothing happens. */
  innerDeadzone: number;
  /** Turn rate at full stick, degrees per second. */
  maxTurnRate: number;
  /** 1 = linear, >1 = slow near the centre and fast near the edge. */
  responseCurve: number;
  /** Vertical turn rate relative to horizontal at the same stick value. */
  verticalRatio: number;
  /** radial: deadzone on the stick vector (most games). axial: per axis. */
  deadzoneShape: 'radial' | 'axial';
  /** Look-rate multiplier while aiming down sights (left trigger). */
  adsLookScale: number;
  /** Also turn by the gyro (games with gyro aiming). */
  gyroAim: boolean;
}

export function defaultGameSettings(): GameSettings {
  return {
    innerDeadzone: 0.1,
    maxTurnRate: 360,
    responseCurve: 1,
    verticalRatio: 1,
    deadzoneShape: 'radial',
    adsLookScale: 1,
    gyroAim: false,
  };
}

/** The part of a game's settings that turns a stick vector into camera rotation. */
export type LookModel = Pick<
  GameSettings,
  'innerDeadzone' | 'maxTurnRate' | 'responseCurve' | 'verticalRatio' | 'deadzoneShape'
>;

/** Stick vector to camera turn rates, in degrees per second. `down` is positive when looking down. */
export function gameLookRates(s: LookModel, x: number, y: number): { yaw: number; down: number } {
  const dz = s.innerDeadzone;
  const shaped = (magnitude: number): number => {
    if (magnitude <= dz) return 0;
    return Math.pow(Math.min(1, (magnitude - dz) / (1 - dz)), s.responseCurve);
  };
  if (s.deadzoneShape === 'axial') {
    return {
      yaw: Math.sign(x) * shaped(Math.abs(x)) * s.maxTurnRate,
      down: Math.sign(y) * shaped(Math.abs(y)) * s.maxTurnRate * s.verticalRatio,
    };
  }
  const m = Math.hypot(x, y);
  if (m <= dz) return { yaw: 0, down: 0 };
  const rate = shaped(m) * s.maxTurnRate;
  return { yaw: (rate * x) / m, down: (rate * s.verticalRatio * y) / m };
}

export const MAP_ROWS: readonly string[] = [
  '################',
  '#..............#',
  '#..##......##..#',
  '#..#........#..#',
  '#..............#',
  '#......##......#',
  '#......##......#',
  '#..............#',
  '#..............#',
  '#......##......#',
  '#..............#',
  '#..#........#..#',
  '#..##......##..#',
  '#..............#',
  '#..............#',
  '################',
];
export const MAP_SIZE = 16;

export function isWall(x: number, y: number): boolean {
  const mx = Math.floor(x);
  const my = Math.floor(y);
  if (mx < 0 || my < 0 || mx >= MAP_SIZE || my >= MAP_SIZE) return true;
  return MAP_ROWS[my]![mx] === '#';
}

export interface Target {
  x: number;
  y: number;
  /** Seconds left of the white hit flash. */
  flash: number;
  /** Seconds until it is back. 0 = alive. */
  respawn: number;
}

export interface RayHit {
  /** Distance along the ray direction vector (perpendicular to the camera plane for camera rays). */
  perp: number;
  /** 0 = hit an east/west face, 1 = hit a north/south face. */
  side: 0 | 1;
  mapX: number;
  mapY: number;
  /** Direction the ray was travelling in the axis that was hit: +1 or -1. */
  step: 1 | -1;
}

const RAD = Math.PI / 180;
const MOVE_SPEED = 3.2;
const SPRINT_FACTOR = 1.6;
const MOVE_DEADZONE = 0.1;
const BODY_RADIUS = 0.22;
const MAX_PITCH = 60;
const FIRE_INTERVAL = 0.16;
const TARGET_RADIUS = 0.35;
const FOV_NORMAL = 90;
const FOV_ADS = 55;

const TARGET_START: ReadonlyArray<[number, number]> = [
  [6.5, 3.5], [10.5, 3.5], [2.5, 8.5], [13.5, 8.5], [5.5, 13.5],
  [10.5, 13.5], [8.5, 1.5], [8.5, 14.5], [2.5, 4.5], [13.5, 5.5],
];

export class FpsGame {
  settings: GameSettings;
  x = 8.5;
  y = 8.5;
  /** Degrees in [0, 360). */
  yaw = 0;
  pitch = 0;
  /** Total turned since reset, unwrapped. Lets a test or a readout measure angles over many turns. */
  yawTotal = 0;
  targets: Target[] = [];
  shots = 0;
  hits = 0;
  muzzle = 0;
  hitMarker = 0;
  /** 0..1 progress of the aim-down-sights zoom. */
  adsAmount = 0;
  /** Last look rates applied, degrees per second (positive yaw = right, positive pitch = up). */
  lastYawRate = 0;
  lastPitchRate = 0;
  moving = false;

  #cooldown = 0;
  #seed: number;

  constructor(settings: GameSettings = defaultGameSettings(), seed = 1) {
    this.settings = settings;
    this.#seed = seed >>> 0;
    this.reset();
  }

  reset(): void {
    this.x = 8.5;
    this.y = 8.5;
    this.yaw = 0;
    this.pitch = 0;
    this.yawTotal = 0;
    this.shots = 0;
    this.hits = 0;
    this.muzzle = 0;
    this.hitMarker = 0;
    this.adsAmount = 0;
    this.#cooldown = 0;
    this.targets = TARGET_START.map(([x, y]) => ({ x, y, flash: 0, respawn: 0 }));
  }

  get fov(): number {
    return FOV_NORMAL + (FOV_ADS - FOV_NORMAL) * this.adsAmount;
  }

  #random(): number {
    this.#seed = (Math.imul(this.#seed, 1664525) + 1013904223) >>> 0;
    return this.#seed / 4294967296;
  }

  #blocked(x: number, y: number): boolean {
    const r = BODY_RADIUS;
    return isWall(x - r, y - r) || isWall(x + r, y - r) || isWall(x - r, y + r) || isWall(x + r, y + r);
  }

  /** Cast a ray from the player. `dx`/`dy` is the ray direction (not necessarily unit length). */
  castRay(dx: number, dy: number): RayHit {
    let mapX = Math.floor(this.x);
    let mapY = Math.floor(this.y);
    const deltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
    const deltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
    const stepX: 1 | -1 = dx < 0 ? -1 : 1;
    const stepY: 1 | -1 = dy < 0 ? -1 : 1;
    let sideX = dx < 0 ? (this.x - mapX) * deltaX : (mapX + 1 - this.x) * deltaX;
    let sideY = dy < 0 ? (this.y - mapY) * deltaY : (mapY + 1 - this.y) * deltaY;
    let side: 0 | 1 = 0;
    for (let i = 0; i < 64; i++) {
      if (sideX < sideY) {
        sideX += deltaX;
        mapX += stepX;
        side = 0;
      } else {
        sideY += deltaY;
        mapY += stepY;
        side = 1;
      }
      if (isWall(mapX, mapY)) break;
    }
    const perp = side === 0 ? sideX - deltaX : sideY - deltaY;
    return { perp, side, mapX, mapY, step: side === 0 ? stepX : stepY };
  }

  /** Advance the game by `dt` seconds using only pad input. */
  update(pad: VirtualPadState, dt: number): void {
    const s = this.settings;

    // Look.
    const look = gameLookRates(s, pad.rightX, pad.rightY);
    const ads = pad.l2 > 128;
    const scale = ads ? s.adsLookScale : 1;
    let yawRate = look.yaw * scale;
    let downRate = look.down * scale;
    if (s.gyroAim) {
      yawRate += pad.gyro.y * (180 / Math.PI) * scale;
      downRate += pad.gyro.x * (180 / Math.PI) * scale;
    }
    this.yawTotal += yawRate * dt;
    this.yaw = (((this.yaw + yawRate * dt) % 360) + 360) % 360;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch - downRate * dt));
    this.lastYawRate = yawRate;
    this.lastPitchRate = -downRate;
    this.adsAmount += ((ads ? 1 : 0) - this.adsAmount) * Math.min(1, dt * 12);

    // Move.
    const forwardIn = -pad.leftY;
    const strafeIn = pad.leftX;
    const m = Math.hypot(forwardIn, strafeIn);
    let forward = 0;
    let strafe = 0;
    if (m > MOVE_DEADZONE) {
      const k = Math.min(1, (m - MOVE_DEADZONE) / (1 - MOVE_DEADZONE)) / m;
      forward = forwardIn * k;
      strafe = strafeIn * k;
    }
    this.moving = forward !== 0 || strafe !== 0;
    const speed = MOVE_SPEED * ((pad.buttons & BUTTON.l3) !== 0 ? SPRINT_FACTOR : 1);
    const yawRad = this.yaw * RAD;
    const dirX = Math.cos(yawRad);
    const dirY = Math.sin(yawRad);
    const moveX = (dirX * forward - dirY * strafe) * speed * dt;
    const moveY = (dirY * forward + dirX * strafe) * speed * dt;
    if (!this.#blocked(this.x + moveX, this.y)) this.x += moveX;
    if (!this.#blocked(this.x, this.y + moveY)) this.y += moveY;

    // Shoot with the right trigger.
    this.#cooldown = Math.max(0, this.#cooldown - dt);
    this.muzzle = Math.max(0, this.muzzle - dt);
    this.hitMarker = Math.max(0, this.hitMarker - dt);
    if (pad.r2 > 128 && this.#cooldown === 0) {
      this.#cooldown = FIRE_INTERVAL;
      this.#shoot();
    }

    // Targets.
    for (const t of this.targets) {
      if (t.flash > 0) t.flash = Math.max(0, t.flash - dt);
      if (t.respawn > 0) {
        t.respawn -= dt;
        if (t.respawn <= 0) this.#relocate(t);
      }
    }
  }

  #shoot(): void {
    this.shots++;
    this.muzzle = 0.06;
    const yawRad = this.yaw * RAD;
    const dirX = Math.cos(yawRad);
    const dirY = Math.sin(yawRad);
    const wallDistance = this.castRay(dirX, dirY).perp;
    const rise = Math.tan(this.pitch * RAD);
    let best: Target | null = null;
    let bestDistance = Infinity;
    for (const t of this.targets) {
      if (t.respawn > 0) continue;
      const relX = t.x - this.x;
      const relY = t.y - this.y;
      const along = relX * dirX + relY * dirY;
      if (along <= 0.1 || along >= wallDistance) continue;
      const lateral = dirX * relY - dirY * relX;
      if (Math.abs(lateral) < TARGET_RADIUS && Math.abs(rise * along) < TARGET_RADIUS && along < bestDistance) {
        best = t;
        bestDistance = along;
      }
    }
    if (best) {
      this.hits++;
      this.hitMarker = 0.18;
      best.flash = 0.18;
      best.respawn = 0.6;
    }
  }

  #relocate(t: Target): void {
    for (let i = 0; i < 60; i++) {
      const x = 1 + Math.floor(this.#random() * (MAP_SIZE - 2)) + 0.5;
      const y = 1 + Math.floor(this.#random() * (MAP_SIZE - 2)) + 0.5;
      if (isWall(x, y) || Math.hypot(x - this.x, y - this.y) < 3) continue;
      t.x = x;
      t.y = y;
      return;
    }
    t.respawn = 0.5;
  }

  /** Compass name of the current heading. */
  get heading(): string {
    return ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'][Math.round(this.yaw / 45) % 8]!;
  }
}
