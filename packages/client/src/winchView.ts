import * as THREE from 'three';
import type { WinchLinkSnapshot } from '@mydrunner/shared';

const SEGMENTS = 16;

interface CableVisual {
  line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  positions: Float32Array;
}

export class WinchView {
  readonly group = new THREE.Group();
  readonly marker: THREE.Mesh;
  private readonly cables = new Map<string, CableVisual>();

  constructor() {
    this.group.name = 'winches';
    this.marker = new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.035, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0xf4bf4f, depthTest: false }),
    );
    this.marker.rotation.x = Math.PI / 2;
    this.marker.renderOrder = 10;
    this.marker.visible = false;
    this.group.add(this.marker);
  }

  setTarget(point: { x: number; y: number; z: number } | null, valid = false): void {
    this.marker.visible = point !== null;
    if (!point) return;
    this.marker.position.set(point.x, point.y, point.z);
    (this.marker.material as THREE.MeshBasicMaterial).color.setHex(valid ? 0x69e38a : 0xe46955);
  }

  update(
    links: readonly WinchLinkSnapshot[],
    endpoint: (link: WinchLinkSnapshot, end: 'source' | 'target') => THREE.Vector3 | null,
  ): void {
    const present = new Set<string>();
    for (const link of links) {
      const start = endpoint(link, 'source');
      const end = endpoint(link, 'target');
      if (!start || !end) continue;
      present.add(link.id);
      let visual = this.cables.get(link.id);
      if (!visual) {
        const positions = new Float32Array((SEGMENTS + 1) * 3);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const material = new THREE.LineBasicMaterial({ color: 0x323232 });
        const line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        this.group.add(line);
        visual = { line, positions };
        this.cables.set(link.id, visual);
      }
      const distance = start.distanceTo(end);
      const slack = Math.max(0, link.cableLength - distance);
      const sag = Math.min(2, slack * 0.8);
      for (let i = 0; i <= SEGMENTS; i++) {
        const t = i / SEGMENTS;
        const offset = i * 3;
        visual.positions[offset] = start.x + (end.x - start.x) * t;
        visual.positions[offset + 1] = start.y + (end.y - start.y) * t - 4 * sag * t * (1 - t);
        visual.positions[offset + 2] = start.z + (end.z - start.z) * t;
      }
      visual.line.geometry.attributes.position!.needsUpdate = true;
      visual.line.material.color.setHex(link.status === 'overload' ? 0xd84b3e : link.status === 'stalled' ? 0xd8953e : 0x303238);
    }
    for (const [id, visual] of this.cables) {
      if (present.has(id)) continue;
      this.group.remove(visual.line);
      visual.line.geometry.dispose();
      visual.line.material.dispose();
      this.cables.delete(id);
    }
  }
}
