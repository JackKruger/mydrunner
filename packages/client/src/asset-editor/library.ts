import * as THREE from 'three';
import {
  Physics,
  VEHICLE_BASE_IDS,
  createStockBuild,
  resolveVehicleSpec,
  type VehicleBaseId,
} from '@mydrunner/shared';
import { buildCarMesh } from '../carMesh.js';
import { Obstacles } from '../obstacles/index.js';
import { disposeObject3D } from '../three/dispose.js';
import {
  ASSET_DOCUMENT_VERSION,
  blankDocument,
  type AssetDocument,
  type AssetPart,
  type PartGeometry,
} from './document.js';

export interface LibraryAsset {
  id: string;
  label: string;
  group: string;
}

const GROUP_NAMES: Record<string, string> = {
  natural: 'Natural', trail: 'Trail', props: 'Props & buildings', markers: 'Markers',
};

export const LIBRARY_ASSETS: LibraryAsset[] = [
  { id: 'blank', label: 'Empty asset', group: 'Start' },
  ...VEHICLE_BASE_IDS.map((baseId) => ({
    id: `vehicle:${baseId}`,
    label: resolveVehicleSpec(createStockBuild(baseId)).displayName,
    group: 'Vehicles',
  })),
  ...Physics.OBJECT_KINDS.map((kind) => ({
    id: `object:${kind}`,
    label: Physics.OBJECT_INFO[kind].label,
    group: GROUP_NAMES[Physics.OBJECT_INFO[kind].group] ?? 'Objects',
  })),
];

function materialOf(mesh: THREE.Mesh): THREE.MeshStandardMaterial | null {
  const value = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return value instanceof THREE.MeshStandardMaterial ? value : null;
}

function geometryOf(geometry: THREE.BufferGeometry): PartGeometry | null {
  const p = (geometry as THREE.BufferGeometry & { parameters?: Record<string, number> }).parameters;
  if (!p) return null;
  if (geometry.type === 'BoxGeometry') return {
    kind: 'box', size: [p.width ?? 1, p.height ?? 1, p.depth ?? 1],
  };
  if (geometry.type === 'ConeGeometry') return {
    kind: 'cone', radius: p.radius ?? 0.5, height: p.height ?? 1, segments: p.radialSegments ?? 8,
  };
  if (geometry.type === 'CylinderGeometry') return {
    kind: 'cylinder', radiusTop: p.radiusTop ?? 0.5, radiusBottom: p.radiusBottom ?? 0.5,
    height: p.height ?? 1, segments: p.radialSegments ?? 10,
  };
  if (geometry.type === 'IcosahedronGeometry' || geometry.type === 'SphereGeometry') return {
    kind: 'sphere', radius: p.radius ?? 0.5, detail: p.detail ?? 1,
  };
  if (geometry.type === 'TorusGeometry') return {
    kind: 'torus', radius: p.radius ?? 0.5, tube: p.tube ?? 0.15,
    radialSegments: p.radialSegments ?? 8, tubularSegments: p.tubularSegments ?? 16,
  };
  if (geometry.type === 'PlaneGeometry') return {
    kind: 'plane', size: [p.width ?? 1, p.height ?? 1],
  };
  return null;
}

function flatten(root: THREE.Object3D, name: string): AssetDocument {
  root.updateMatrixWorld(true);
  const parts: AssetPart[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = geometryOf(object.geometry);
    if (!geometry) return;
    const material = materialOf(object);
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    object.matrixWorld.decompose(position, rotation, scale);
    const euler = new THREE.Euler().setFromQuaternion(rotation, 'XYZ');
    const color = material ? `#${material.color.getHexString()}` : '#8b9295';
    const index = parts.length + 1;
    parts.push({
      id: `part-${index}`,
      name: object.name || `${geometry.kind} ${index}`,
      geometry,
      transform: {
        position: [position.x, position.y, position.z],
        rotation: [euler.x, euler.y, euler.z],
        scale: [Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)],
      },
      material: {
        color,
        roughness: material?.roughness ?? 0.8,
        metalness: material?.metalness ?? 0,
        opacity: material?.opacity ?? 1,
      },
    });
  });
  disposeObject3D(root);
  return { version: ASSET_DOCUMENT_VERSION, name, parts };
}

export function loadLibraryAsset(id: string): AssetDocument {
  if (id === 'blank') return blankDocument();
  if (id.startsWith('vehicle:')) {
    const baseId = id.slice('vehicle:'.length) as VehicleBaseId;
    if (!VEHICLE_BASE_IDS.includes(baseId)) throw new Error('Unknown vehicle template');
    const build = createStockBuild(baseId);
    const spec = resolveVehicleSpec(build);
    return flatten(buildCarMesh(build, true, 0).group, spec.displayName);
  }
  if (id.startsWith('object:')) {
    const kind = id.slice('object:'.length);
    if (!Physics.isObstacleKind(kind)) throw new Error('Unknown object template');
    const info = Physics.OBJECT_INFO[kind];
    const source = new Obstacles([{
      id: `asset-template-${kind}`,
      kind,
      x: 0, y: 0, z: 0, yaw: 0,
      size: info.defaults.size,
      height: info.defaults.height,
      ...(info.defaults.length === undefined ? {} : { length: info.defaults.length }),
    }]);
    return flatten(source.group, info.label);
  }
  throw new Error('Unknown library asset');
}
