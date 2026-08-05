// Free-fly camera for the editor: WASD to move, right-drag to look.
//
// Right-drag rather than pointer-lock look: the left button is the brush,
// and a locked pointer would make placing a single object impossible
// without a modifier. Right-drag also leaves the cursor where it was when
// you release, so you can orbit a hillside and come back to the same cell.

import * as THREE from 'three';

const MOVE_SPEED = 40;      // m/s at the default throttle
const BOOST = 4;            // shift multiplier: crossing a 320 m map
const CRAWL = 0.2;          // ctrl multiplier: placing objects precisely
const LOOK_PER_PX = 1 / 350; // radians of yaw/pitch per pixel dragged
const PITCH_LIMIT = Math.PI / 2 - 0.02;
const FLOOR_CLEARANCE = 1.5; // m above ground, so you cannot fly into it

export class FlyCamera {
  readonly camera: THREE.PerspectiveCamera;
  private yaw = 0;
  private pitch = -0.5;
  private keys = new Set<string>();
  private looking = false;
  private groundAt: ((x: number, z: number) => number) | null = null;
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();

  constructor(aspect: number, start: { x: number; y: number; z: number }) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.2, 2000);
    this.camera.position.set(start.x, start.y, start.z);
    this.applyRotation();
  }

  setGroundSampler(fn: (x: number, z: number) => number): void {
    this.groundAt = fn;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Keyboard state. Held keys are tracked rather than acted on directly
   *  so movement is frame-rate independent — a key event is not a
   *  distance. */
  onKey(code: string, down: boolean): void {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  clearKeys(): void {
    this.keys.clear();
  }

  beginLook(): void { this.looking = true; }
  endLook(): void { this.looking = false; }
  get isLooking(): boolean { return this.looking; }

  look(dxPx: number, dyPx: number): void {
    if (!this.looking) return;
    this.yaw -= dxPx * LOOK_PER_PX;
    this.pitch = clamp(this.pitch - dyPx * LOOK_PER_PX, -PITCH_LIMIT, PITCH_LIMIT);
    this.applyRotation();
  }

  update(dt: number): void {
    let speed = MOVE_SPEED;
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) speed *= BOOST;
    if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) speed *= CRAWL;

    const fwd = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const rise = (this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0);
    if (fwd === 0 && strafe === 0 && rise === 0) return;

    this.camera.getWorldDirection(this.forward);
    this.right.crossVectors(this.forward, this.camera.up).normalize();
    const step = speed * dt;
    this.camera.position.addScaledVector(this.forward, fwd * step);
    this.camera.position.addScaledVector(this.right, strafe * step);
    this.camera.position.y += rise * step;

    // Floor clamp. Dropping below the terrain shows the mesh backfaces
    // and there is no way to tell which way is up from under there.
    if (this.groundAt) {
      const floor = this.groundAt(this.camera.position.x, this.camera.position.z) + FLOOR_CLEARANCE;
      if (this.camera.position.y < floor) this.camera.position.y = floor;
    }
  }

  /** Frame a point from a comfortable working distance. */
  lookAtPoint(x: number, y: number, z: number, distance = 60): void {
    this.camera.position.set(x, y + distance * 0.7, z + distance * 0.7);
    const dx = x - this.camera.position.x;
    const dy = y - this.camera.position.y;
    const dz = z - this.camera.position.z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    this.applyRotation();
  }

  private applyRotation(): void {
    // YXZ so yaw is applied about world up and pitch about the camera's
    // own right axis; the default XYZ order rolls the horizon as you turn.
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
