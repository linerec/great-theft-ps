// SPDX-License-Identifier: AGPL-3.0-only
//
// A small third-person test bed in the style of GTA V, driven only by a VirtualPadState.
//
// Grounded in public sources for GTA V on PlayStation: sprint is tapping X repeatedly, jump is Square,
// aim is L2, enter vehicle is Triangle, cover is R1, vehicle accelerate is R2. GTA V also has third-person
// look settings for deadzone, acceleration and (aim) sensitivity, and several targeting modes.
// NOT grounded, so these are test bed assumptions: every number (speeds, camera distance, turn rates),
// the exact camera acceleration formula, the walk/jog/run thresholds, brake on L2 and handbrake on Square.
// It is a stand-in for judging the mapping, not a copy of the game.
//
// World: X points east, Z points south, Y up (metres). yaw 0 = east and positive yaw turns right.
// Pitch is positive when the camera looks UP.

import { t } from '../i18n/index.ts';
import { BUTTON, type VirtualPadState } from '../engine/types.ts';
import { gameLookRates, type LookModel } from './fps.ts';

export interface TpsSettings extends LookModel {
  /** 0..1. Extra camera speed (up to +100%) after the stick has been held far out for a moment. */
  lookAcceleration: number;
  /** Look-speed multiplier while aiming (L2). */
  aimLookScale: number;
  /** Soft pull of the camera toward the nearest target while aiming (GTA's assisted aim). */
  aimAssist: boolean;
}

export function defaultTpsSettings(): TpsSettings {
  return {
    innerDeadzone: 0.1,
    maxTurnRate: 360,
    responseCurve: 1,
    verticalRatio: 1,
    deadzoneShape: 'radial',
    lookAcceleration: 0,
    aimLookScale: 1,
    aimAssist: false,
  };
}

export type Rgb = [number, number, number];

export interface Building {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  h: number;
  color: Rgb;
}

export const WORLD_SIZE = 80;

export const BUILDINGS: readonly Building[] = [
  // north-west
  { x0: 8, z0: 8, x1: 20, z1: 18, h: 10, color: [150, 158, 176] },
  { x0: 24, z0: 10, x1: 32, z1: 22, h: 7, color: [176, 160, 146] },
  { x0: 8, z0: 24, x1: 18, z1: 32, h: 5, color: [140, 164, 152] },
  // north-east
  { x0: 50, z0: 8, x1: 62, z1: 16, h: 9, color: [168, 150, 150] },
  { x0: 66, z0: 10, x1: 74, z1: 24, h: 12, color: [146, 154, 178] },
  { x0: 50, z0: 22, x1: 60, z1: 32, h: 6, color: [172, 166, 140] },
  // south-west
  { x0: 6, z0: 48, x1: 16, z1: 60, h: 8, color: [158, 148, 172] },
  { x0: 20, z0: 50, x1: 30, z1: 58, h: 5, color: [140, 160, 168] },
  { x0: 8, z0: 64, x1: 22, z1: 74, h: 11, color: [170, 156, 140] },
  // south-east
  { x0: 50, z0: 48, x1: 60, z1: 60, h: 7, color: [150, 168, 150] },
  { x0: 64, z0: 50, x1: 74, z1: 62, h: 10, color: [164, 150, 170] },
  { x0: 52, z0: 66, x1: 66, z1: 74, h: 6, color: [146, 158, 166] },
  // compass towers: north red, east green, south blue, west yellow
  { x0: 38, z0: 2, x1: 42, z1: 6, h: 26, color: [220, 70, 66] },
  { x0: 74, z0: 38, x1: 78, z1: 42, h: 26, color: [70, 170, 80] },
  { x0: 38, z0: 74, x1: 42, z1: 78, h: 26, color: [66, 126, 232] },
  { x0: 2, z0: 38, x1: 6, z1: 42, h: 26, color: [232, 196, 60] },
];

export interface TpsTarget {
  x: number;
  z: number;
  flash: number;
  respawn: number;
}

export interface CameraPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  fov: number;
}

export interface Car {
  x: number;
  z: number;
  /** Degrees, same convention as yaw. */
  heading: number;
  /** Metres per second along the heading, negative when reversing. */
  speed: number;
}

const RAD = Math.PI / 180;
const BODY_RADIUS = 0.4;
const CAR_RADIUS = 1.3;
const LOOK_ACCEL_SECONDS = 0.4;
const LOOK_ACCEL_THRESHOLD = 0.35;
const PITCH_MIN = -60;
const PITCH_MAX = 50;
const FIRE_INTERVAL = 0.14;
const TARGET_RADIUS = 0.7;
const ENTER_DISTANCE = 3.5;

const TARGET_START: ReadonlyArray<[number, number]> = [
  [30, 38], [56, 41], [40, 56], [40, 66], [20, 41], [66, 39], [40, 18], [30, 68], [47, 66], [46, 30],
];

function wrap180(a: number): number {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

function insideBuilding(x: number, z: number, r: number): boolean {
  if (x < 1 + r || z < 1 + r || x > WORLD_SIZE - 1 - r || z > WORLD_SIZE - 1 - r) return true;
  for (const b of BUILDINGS) {
    if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r) return true;
  }
  return false;
}

/** Distance along a ray to an axis-aligned box, or Infinity. */
export function rayBox(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): number {
  let tMin = 0;
  let tMax = Infinity;
  const slab = (o: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    let t0 = (lo - o) / d;
    let t1 = (hi - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tMin = Math.max(tMin, t0);
    tMax = Math.min(tMax, t1);
    return tMin <= tMax;
  };
  return slab(ox, dx, x0, x1) && slab(oy, dy, y0, y1) && slab(oz, dz, z0, z1) ? tMin : Infinity;
}

export class TpsGame {
  settings: TpsSettings;

  // On foot.
  x = 41.5;
  z = 41;
  /** Height above the ground (jumping). */
  y = 0;
  /** Facing direction of the character, degrees. */
  heading = 0;
  speed = 0;
  sprintCharge = 0;
  inVehicle = false;

  // Camera.
  yaw = 0;
  pitch = -8;
  yawTotal = 0;
  lastYawRate = 0;
  lastPitchRate = 0;
  aiming = false;
  aimAmount = 0;

  car: Car = { x: 48, z: 41, heading: 0, speed: 0 };
  targets: TpsTarget[] = [];
  shots = 0;
  hits = 0;
  muzzle = 0;
  hitMarker = 0;

  #vy = 0;
  #moveX = 1;
  #moveZ = 0;
  #lookHold = 0;
  #idleLook = 0;
  #cooldown = 0;
  #prev = { cross: false, box: false, pyramid: false };
  #seed: number;

  constructor(settings: TpsSettings = defaultTpsSettings(), seed = 7) {
    this.settings = settings;
    this.#seed = seed >>> 0;
    this.reset();
  }

  reset(): void {
    this.x = 41.5;
    this.z = 41;
    this.y = 0;
    this.heading = 0;
    this.speed = 0;
    this.sprintCharge = 0;
    this.inVehicle = false;
    this.yaw = 0;
    this.pitch = -8;
    this.yawTotal = 0;
    this.aiming = false;
    this.aimAmount = 0;
    this.car = { x: 48, z: 41, heading: 0, speed: 0 };
    this.shots = 0;
    this.hits = 0;
    this.muzzle = 0;
    this.hitMarker = 0;
    this.targets = TARGET_START.map(([x, z]) => ({ x, z, flash: 0, respawn: 0 }));
    this.#vy = 0;
    this.#moveX = 1;
    this.#moveZ = 0;
    this.#lookHold = 0;
    this.#idleLook = 0;
    this.#cooldown = 0;
    this.#prev = { cross: false, box: false, pyramid: false };
  }

  #random(): number {
    this.#seed = (Math.imul(this.#seed, 1664525) + 1013904223) >>> 0;
    return this.#seed / 4294967296;
  }

  get fov(): number {
    return this.inVehicle ? 75 : 70 + (50 - 70) * this.aimAmount;
  }

  /** The pivot the camera orbits: the character's head, or the middle of the car. */
  get pivot(): { x: number; y: number; z: number } {
    if (this.inVehicle) return { x: this.car.x, y: 1.5, z: this.car.z };
    const right = this.yaw * RAD + Math.PI / 2;
    const shoulder = 0.6 * this.aimAmount;
    return { x: this.x + Math.cos(right) * shoulder, y: 1.55 + this.y, z: this.z + Math.sin(right) * shoulder };
  }

  cameraPose(): CameraPose {
    const p = this.pivot;
    const distance = this.inVehicle ? 7.5 : 4.2 + (2.1 - 4.2) * this.aimAmount;
    const cp = Math.cos(this.pitch * RAD);
    const fx = cp * Math.cos(this.yaw * RAD);
    const fy = Math.sin(this.pitch * RAD);
    const fz = cp * Math.sin(this.yaw * RAD);
    return {
      x: p.x - fx * distance,
      y: Math.max(0.4, p.y - fy * distance),
      z: p.z - fz * distance,
      yaw: this.yaw,
      pitch: this.pitch,
      fov: this.fov,
    };
  }

  /** Speed in km/h, for the HUD. */
  get speedKmh(): number {
    return Math.abs(this.inVehicle ? this.car.speed : this.speed) * 3.6;
  }

  /** A short name for what the character is doing, in the language of the page (it is drawn again every frame). */
  get movementName(): string {
    if (this.inVehicle) return t('Driving');
    if (this.aiming) return t('Aiming');
    if (this.speed < 0.2) return t('Standing');
    if (this.speed < 2) return t('Walking');
    if (this.speed < 4.2) return t('Jogging');
    if (this.speed < 5.6) return t('Running');
    return t('Sprinting');
  }

  update(pad: VirtualPadState, dt: number): void {
    const s = this.settings;
    const cross = (pad.buttons & BUTTON.cross) !== 0;
    const square = (pad.buttons & BUTTON.box) !== 0;
    const triangle = (pad.buttons & BUTTON.pyramid) !== 0;
    const crossEdge = cross && !this.#prev.cross;
    const squareEdge = square && !this.#prev.box;
    const triangleEdge = triangle && !this.#prev.pyramid;
    this.#prev = { cross, box: square, pyramid: triangle };

    // Enter or leave the car.
    if (triangleEdge) {
      if (!this.inVehicle && Math.hypot(this.x - this.car.x, this.z - this.car.z) < ENTER_DISTANCE) {
        this.inVehicle = true;
        this.speed = 0;
      } else if (this.inVehicle && Math.abs(this.car.speed) < 8) {
        this.inVehicle = false;
        const side = (this.car.heading + 90) * RAD;
        this.x = this.car.x + Math.cos(side) * 2.2;
        this.z = this.car.z + Math.sin(side) * 2.2;
        this.heading = this.yaw;
      }
    }

    // Camera look: the same stick model a console game applies, plus GTA-style acceleration and aim scaling.
    this.aiming = !this.inVehicle && pad.l2 > 128;
    const look = gameLookRates(s, pad.rightX, pad.rightY);
    const stickLength = Math.hypot(pad.rightX, pad.rightY);
    const pushed = stickLength <= s.innerDeadzone ? 0 : Math.min(1, (stickLength - s.innerDeadzone) / (1 - s.innerDeadzone));
    this.#lookHold = pushed > LOOK_ACCEL_THRESHOLD ? Math.min(LOOK_ACCEL_SECONDS, this.#lookHold + dt) : Math.max(0, this.#lookHold - dt * 4);
    const accel = 1 + s.lookAcceleration * (this.#lookHold / LOOK_ACCEL_SECONDS);
    const scale = (this.aiming ? s.aimLookScale : 1) * accel;
    const yawRate = look.yaw * scale;
    const downRate = look.down * scale;
    this.yaw = (((this.yaw + yawRate * dt) % 360) + 360) % 360;
    this.yawTotal += yawRate * dt;
    this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch - downRate * dt));
    this.lastYawRate = yawRate;
    this.lastPitchRate = -downRate;
    this.aimAmount += ((this.aiming ? 1 : 0) - this.aimAmount) * Math.min(1, dt * 10);

    // Assisted aim: a soft pull toward the nearest target in front.
    if (this.aiming && s.aimAssist) this.#assist(dt);

    if (this.inVehicle) this.#drive(pad, dt, stickLength);
    else this.#walk(pad, dt, crossEdge, squareEdge);

    // Shoot.
    this.#cooldown = Math.max(0, this.#cooldown - dt);
    this.muzzle = Math.max(0, this.muzzle - dt);
    this.hitMarker = Math.max(0, this.hitMarker - dt);
    if (!this.inVehicle && pad.r2 > 128 && this.#cooldown === 0) {
      this.#cooldown = FIRE_INTERVAL;
      this.#shoot();
    }

    for (const t of this.targets) {
      if (t.flash > 0) t.flash = Math.max(0, t.flash - dt);
      if (t.respawn > 0) {
        t.respawn -= dt;
        if (t.respawn <= 0) this.#relocate(t);
      }
    }
  }

  #assist(dt: number): void {
    const o = this.cameraPose();
    let best: { dyaw: number; dpitch: number; angle: number } | null = null;
    for (const t of this.targets) {
      if (t.respawn > 0) continue;
      const dx = t.x - o.x;
      const dy = 1.0 - o.y;
      const dz = t.z - o.z;
      const dyaw = wrap180((Math.atan2(dz, dx) * 180) / Math.PI - this.yaw);
      const dpitch = (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI - this.pitch;
      const angle = Math.hypot(dyaw, dpitch);
      if (angle < 12 && (!best || angle < best.angle)) best = { dyaw, dpitch, angle };
    }
    if (!best) return;
    const k = Math.min(1, dt * 3);
    this.yaw = (((this.yaw + best.dyaw * k) % 360) + 360) % 360;
    this.yawTotal += best.dyaw * k;
    this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch + best.dpitch * k));
  }

  #walk(pad: VirtualPadState, dt: number, crossEdge: boolean, squareEdge: boolean): void {
    // Sprinting means tapping X over and over: each press adds charge and it drains quickly.
    if (crossEdge) this.sprintCharge = Math.min(1, this.sprintCharge + 0.35);
    this.sprintCharge = Math.max(0, this.sprintCharge - dt * 1.6);

    if (squareEdge && this.y === 0) this.#vy = 5.2;
    this.#vy -= 14 * dt;
    this.y = Math.max(0, this.y + this.#vy * dt);
    if (this.y === 0 && this.#vy < 0) this.#vy = 0;

    const forwardIn = -pad.leftY;
    const strafeIn = pad.leftX;
    const m = Math.hypot(forwardIn, strafeIn);
    const mm = m <= 0.1 ? 0 : Math.min(1, (m - 0.1) / 0.9);

    // Walk, jog and run follow how far the stick is pushed.
    let target = 0;
    if (mm > 0) {
      if (this.aiming) target = 1.6 + mm * 1.8;
      else if (mm < 0.4) target = (mm / 0.4) * 1.6;
      else if (mm < 0.85) target = 1.6 + ((mm - 0.4) / 0.45) * 2.2;
      else target = 3.8 + ((mm - 0.85) / 0.15) * 1.4;
      if (!this.aiming && mm > 0.85 && this.sprintCharge > 0.15) target = 5.2 + this.sprintCharge * 3.4;
    }
    const step = 14 * dt;
    this.speed += Math.max(-step, Math.min(step, target - this.speed));

    if (mm > 0) {
      const yawRad = this.yaw * RAD;
      const camX = Math.cos(yawRad);
      const camZ = Math.sin(yawRad);
      const rightX = -camZ;
      const rightZ = camX;
      const dx = camX * forwardIn + rightX * strafeIn;
      const dz = camZ * forwardIn + rightZ * strafeIn;
      const len = Math.hypot(dx, dz) || 1;
      this.#moveX = dx / len;
      this.#moveZ = dz / len;
      // The character turns to face the way it moves, or the camera while aiming.
      const want = this.aiming ? this.yaw : (Math.atan2(this.#moveZ, this.#moveX) * 180) / Math.PI;
      const diff = wrap180(want - this.heading);
      const turn = 720 * dt;
      this.heading = (((this.heading + Math.max(-turn, Math.min(turn, diff))) % 360) + 360) % 360;
    } else if (this.aiming) {
      this.heading = this.yaw;
    }

    const nx = this.x + this.#moveX * this.speed * dt;
    const nz = this.z + this.#moveZ * this.speed * dt;
    if (!insideBuilding(nx, this.z, BODY_RADIUS) && Math.hypot(nx - this.car.x, this.z - this.car.z) > CAR_RADIUS) this.x = nx;
    if (!insideBuilding(this.x, nz, BODY_RADIUS) && Math.hypot(this.x - this.car.x, nz - this.car.z) > CAR_RADIUS) this.z = nz;
  }

  #drive(pad: VirtualPadState, dt: number, rightStickLength: number): void {
    const car = this.car;
    const throttle = pad.r2 / 255;
    const brake = pad.l2 / 255;
    const handbrake = (pad.buttons & BUTTON.box) !== 0;
    const sx = Math.abs(pad.leftX);
    const steerIn = sx <= 0.08 ? 0 : (Math.sign(pad.leftX) * (sx - 0.08)) / 0.92;

    let a = 0;
    if (car.speed > 0.3 || (car.speed >= -0.3 && throttle > 0 && brake === 0)) {
      a = throttle * 9 - (car.speed > 0.3 ? brake * 16 : 0);
    } else if (brake > 0 && throttle === 0) {
      a = -brake * 5;
    } else if (throttle > 0) {
      a = throttle * 16;
    }
    a -= car.speed * 0.25 + Math.sign(car.speed) * 0.6;
    if (handbrake) a -= Math.sign(car.speed) * 10;
    const before = car.speed;
    car.speed = Math.max(-7, Math.min(30, car.speed + a * dt));
    if (handbrake && Math.sign(before) !== Math.sign(car.speed) && before !== 0) car.speed = 0;
    if (throttle === 0 && brake === 0 && Math.abs(car.speed) < 0.15) car.speed = 0;

    const steerAngle = (steerIn * 0.55) / (1 + Math.abs(car.speed) * 0.07) * (handbrake ? 1.6 : 1);
    car.heading = (((car.heading + ((car.speed / 2.7) * Math.tan(steerAngle) * dt * 180) / Math.PI) % 360) + 360) % 360;
    const h = car.heading * RAD;
    const nx = car.x + Math.cos(h) * car.speed * dt;
    const nz = car.z + Math.sin(h) * car.speed * dt;
    if (insideBuilding(nx, nz, CAR_RADIUS)) car.speed *= -0.25;
    else {
      car.x = nx;
      car.z = nz;
    }

    // The camera swings back behind the car when the right stick is left alone.
    this.#idleLook = rightStickLength <= this.settings.innerDeadzone ? this.#idleLook + dt : 0;
    if (this.#idleLook > 1.2 && Math.abs(car.speed) > 2) {
      const diff = wrap180(car.heading - this.yaw);
      const k = Math.min(1, dt * 1.5);
      this.yaw = (((this.yaw + diff * k) % 360) + 360) % 360;
      this.yawTotal += diff * k;
    }
  }

  #shoot(): void {
    this.shots++;
    this.muzzle = 0.06;
    const o = this.cameraPose();
    const cp = Math.cos(o.pitch * RAD);
    const dx = cp * Math.cos(o.yaw * RAD);
    const dy = Math.sin(o.pitch * RAD);
    const dz = cp * Math.sin(o.yaw * RAD);
    let best: TpsTarget | null = null;
    let bestT = Infinity;
    for (const t of this.targets) {
      if (t.respawn > 0) continue;
      const cx = t.x - o.x;
      const cy = 1.0 - o.y;
      const cz = t.z - o.z;
      const along = cx * dx + cy * dy + cz * dz;
      if (along <= 0.3) continue;
      const closest2 = cx * cx + cy * cy + cz * cz - along * along;
      if (closest2 > TARGET_RADIUS * TARGET_RADIUS || along >= bestT) continue;
      let blocked = false;
      for (const b of BUILDINGS) {
        if (rayBox(o.x, o.y, o.z, dx, dy, dz, b.x0, 0, b.z0, b.x1, b.h, b.z1) < along) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        best = t;
        bestT = along;
      }
    }
    if (best) {
      this.hits++;
      this.hitMarker = 0.18;
      best.flash = 0.18;
      best.respawn = 0.6;
    }
  }

  #relocate(t: TpsTarget): void {
    for (let i = 0; i < 60; i++) {
      const x = 4 + this.#random() * (WORLD_SIZE - 8);
      const z = 4 + this.#random() * (WORLD_SIZE - 8);
      if (insideBuilding(x, z, 1) || Math.hypot(x - this.x, z - this.z) < 8) continue;
      t.x = x;
      t.z = z;
      return;
    }
    t.respawn = 0.5;
  }

  /** Compass name of the camera heading. */
  get heading8(): string {
    return ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'][Math.round(this.yaw / 45) % 8]!;
  }
}
