// Turning a pointer position into a place in the world.
//
// Two things are pickable: the ground (for brushes and placement) and an
// obstacle (for deletion). Obstacle meshes carry their id in userData,
// set by Obstacles — picking returns the id rather than the mesh so the
// caller edits the document rather than the scene graph.

import * as THREE from 'three';

export interface GroundHit {
  x: number;
  y: number;
  z: number;
}

export class Picker {
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  /** Pointer position in normalised device coordinates, from a client
   *  (viewport) pixel position. */
  private setRay(
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    clientX: number,
    clientY: number,
  ): void {
    const rect = canvas.getBoundingClientRect();
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, camera);
  }

  /** Where the pointer meets the ground, or null if it points at sky.
   *
   *  Raycasts the real terrain mesh rather than a flat plane at y=0: a
   *  brush aimed at a hillside from a low angle lands metres away from
   *  the plane intersection, and on the mountain it misses entirely. */
  ground(
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    mesh: THREE.Mesh,
    clientX: number,
    clientY: number,
  ): GroundHit | null {
    this.setRay(canvas, camera, clientX, clientY);
    const hits = this.raycaster.intersectObject(mesh, false);
    const p = hits[0]?.point;
    return p ? { x: p.x, y: p.y, z: p.z } : null;
  }

  /** The id of the obstacle under the pointer, or null.
   *
   *  Walks up from the hit mesh because an obstacle is a Group of parts
   *  (trunk + canopy, say) and only the group carries the id. */
  obstacle(
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    group: THREE.Object3D,
    clientX: number,
    clientY: number,
  ): string | null {
    this.setRay(canvas, camera, clientX, clientY);
    const hits = this.raycaster.intersectObject(group, true);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        const id = node.userData?.obstacleId;
        if (typeof id === 'string') return id;
        node = node.parent;
      }
    }
    return null;
  }
}
