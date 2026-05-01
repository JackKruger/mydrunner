// Camera modes for the local player. Owns its own THREE.PerspectiveCamera
// plus the smoothing state for chase/hood/free. The Scene composes one
// ChaseCamera and forwards target updates each prediction frame.
//
// Modes:
//   chase  - third-person follow with under-damped yaw spring (corner
//            swing) and pitch-aware lookAt (up the hill / down the hill).
//   hood   - hood-mounted first-person, looks straight ahead.
//   free   - high "sky cam" trailing the local player.

import * as THREE from 'three';
import { CAMERA } from '@mydrunner/shared';

export type CameraMode = 'chase' | 'hood' | 'free';

/** What the chase camera needs to know about the terrain to keep itself
 *  out of the ground. The Scene injects an adapter over its terrain mesh. */
export interface TerrainSampler {
  heightAt(x: number, z: number): number;
}

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  /** World-space anchor (the local car). Tracks position with a light
   *  lerp so chassis wobble doesn't get into the camera. */
  readonly target = new THREE.Vector3();
  /** Smoothed chassis yaw (spring) and pitch (lerp), driven by the
   *  chassis quaternion in follow(). */
  yaw = 0;
  pitch = 0;
  private yawVel = 0;
  /** User-input camera offsets (touch / mouse drag). Add to chassis-derived
   *  yaw / pitch when the chase camera is rendered, then spring back to
   *  zero after the user releases. Negative pitch = look up. */
  private userYaw = 0;
  private userPitch = 0;
  /** Set while a drag is active so spring-back doesn't fight the drag. */
  private dragging = false;
  private lastUpdateMs = 0;
  private terrain: TerrainSampler | null = null;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 500);
    this.camera.position.set(0, 6, 12);
  }

  setTerrain(t: TerrainSampler | null): void {
    this.terrain = t;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  cycleMode(): void {
    this.mode = this.mode === 'chase' ? 'hood' : this.mode === 'hood' ? 'free' : 'chase';
  }

  /** Begin a user drag - while active, drag offsets accumulate without
   *  decaying. */
  beginDrag(): void {
    this.dragging = true;
  }

  /** Add to the user-driven yaw / pitch offsets. dx and dy are normalised
   *  to radian deltas inside the caller. */
  drag(dyaw: number, dpitch: number): void {
    this.userYaw += dyaw;
    this.userPitch += dpitch;
    // Clamp pitch so the player can't flip the camera fully upside down.
    this.userPitch = Math.max(-Math.PI / 2.4, Math.min(Math.PI / 2.4, this.userPitch));
  }

  /** Release the drag - spring-back kicks in next apply(). */
  endDrag(): void {
    this.dragging = false;
  }

  /** Soft-track a chassis pose. Position is lerped; yaw uses an
   *  under-damped spring (overshoots a touch through corners); pitch is
   *  lerped (we don't want overshoot here, that would be queasy). */
  follow(
    pos: { x: number; y: number; z: number },
    rot: { x: number; y: number; z: number; w: number },
  ): void {
    this.target.lerp(_vec.set(pos.x, pos.y, pos.z), 0.4);
    // Forward vector (local +Z) rotated by the chassis quaternion.
    const fX = 2 * (rot.x * rot.z + rot.w * rot.y);
    const fY = 2 * (rot.y * rot.z - rot.w * rot.x);
    const fZ = 1 - 2 * (rot.x * rot.x + rot.y * rot.y);
    const targetPitch = Math.asin(Math.max(-1, Math.min(1, fY)));
    this.pitch += (targetPitch - this.pitch) * 0.18;
    const targetYaw = Math.atan2(fX, fZ);
    let dy = targetYaw - this.yaw;
    if (dy > Math.PI) dy -= 2 * Math.PI;
    if (dy < -Math.PI) dy += 2 * Math.PI;
    const nowMs = performance.now();
    const dt = this.lastUpdateMs ? Math.min(0.05, (nowMs - this.lastUpdateMs) / 1000) : 1 / 60;
    this.lastUpdateMs = nowMs;
    const accel = CAMERA.chaseYawStiffness * dy - CAMERA.chaseYawDamping * this.yawVel;
    this.yawVel += accel * dt;
    this.yaw += this.yawVel * dt;
    if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI;
    if (this.yaw < -Math.PI) this.yaw += 2 * Math.PI;
  }

  /** Snap the target without filtering yaw/pitch. Used as a fallback
   *  when client-side prediction isn't driving the camera (interpolated
   *  snapshots only). */
  snapTarget(pos: { x: number; y: number; z: number }): void {
    this.target.set(pos.x, pos.y, pos.z);
  }

  /** Apply the chosen mode to the underlying THREE camera. Call once per
   *  render frame before THREE.WebGLRenderer.render. */
  apply(): void {
    // Spring-back user offsets toward zero unless a drag is in flight.
    // Exponential decay - simple and robust against frame-time variance.
    if (!this.dragging) {
      this.userYaw *= 0.88;
      this.userPitch *= 0.88;
      if (Math.abs(this.userYaw) < 0.001) this.userYaw = 0;
      if (Math.abs(this.userPitch) < 0.001) this.userPitch = 0;
    }
    if (this.mode === 'chase') this.applyChase();
    else if (this.mode === 'hood') this.applyHood();
    else this.applyFree();
  }

  private applyChase(): void {
    // Behind-and-above offset, yawed with the chassis + the user's
    // drag-yaw. User pitch tilts the camera vertically by raising or
    // lowering its Y above the target.
    const effYaw = this.yaw + this.userYaw;
    const sinY = Math.sin(effYaw);
    const cosY = Math.cos(effYaw);
    const distance = 8;
    const heightLift = distance * Math.sin(-this.userPitch);
    _desired.set(
      this.target.x - sinY * distance * Math.cos(this.userPitch),
      this.target.y + 3 + heightLift,
      this.target.z - cosY * distance * Math.cos(this.userPitch),
    );
    // Lateral swing: when yaw is sweeping (cornering), push sideways
    // opposite the sweep so the camera ends up on the outside of the
    // turn. Negative sign because positive yawVel = turning right and
    // we want to push to the world-left of the new heading.
    const swingMag = Math.max(
      -CAMERA.chaseSwingMax,
      Math.min(CAMERA.chaseSwingMax, -this.yawVel * CAMERA.chaseSwingLateral),
    );
    _desired.x += cosY * swingMag;
    _desired.z += -sinY * swingMag;
    const minY = (this.terrain ? this.terrain.heightAt(_desired.x, _desired.z) : 0) + 1.5;
    if (_desired.y < minY) _desired.y = minY;
    this.camera.position.copy(_desired);
    // Project the lookAt point ahead of the car along its yawed heading
    // and lift/drop its height by tan(pitch) * lookAhead - the view
    // angles up driving uphill and down driving downhill.
    const lookAhead = 7;
    const clampedPitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, this.pitch));
    _lookTarget.set(
      this.target.x + Math.sin(this.yaw) * lookAhead,
      this.target.y + 0.5 + lookAhead * Math.tan(clampedPitch),
      this.target.z + Math.cos(this.yaw) * lookAhead,
    );
    this.camera.lookAt(_lookTarget);
  }

  private applyHood(): void {
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    this.camera.position.set(
      this.target.x + sinY * 0.2,
      this.target.y + 1.4,
      this.target.z + cosY * 0.2,
    );
    _lookTarget.set(
      this.target.x + sinY * 10,
      this.target.y + 1.0,
      this.target.z + cosY * 10,
    );
    this.camera.lookAt(_lookTarget);
  }

  private applyFree(): void {
    // High "sky cam" trailing the local player. Sits well above and
    // behind so the camera stays steady while the car drives.
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    this.camera.position.set(
      this.target.x - sinY * 30,
      this.target.y + 40,
      this.target.z - cosY * 30,
    );
    this.camera.lookAt(this.target);
  }
}

// Reused scratch vectors so apply() doesn't allocate per frame.
const _desired = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();
const _vec = new THREE.Vector3();
