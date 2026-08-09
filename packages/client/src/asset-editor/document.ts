export const ASSET_DOCUMENT_VERSION = 1 as const;

export type Vec3 = [number, number, number];
export type PrimitiveKind = 'box' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'plane';

export type PartGeometry =
  | { kind: 'box'; size: Vec3 }
  | { kind: 'cylinder'; radiusTop: number; radiusBottom: number; height: number; segments: number }
  | { kind: 'cone'; radius: number; height: number; segments: number }
  | { kind: 'sphere'; radius: number; detail: number }
  | { kind: 'torus'; radius: number; tube: number; radialSegments: number; tubularSegments: number }
  | { kind: 'plane'; size: [number, number] };

export interface AssetTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export interface AssetMaterial {
  color: string;
  roughness: number;
  metalness: number;
  opacity: number;
}

export interface AssetPart {
  id: string;
  name: string;
  geometry: PartGeometry;
  transform: AssetTransform;
  material: AssetMaterial;
}

export interface AssetDocument {
  version: typeof ASSET_DOCUMENT_VERSION;
  name: string;
  parts: AssetPart[];
}

const DEFAULT_MATERIAL: AssetMaterial = {
  color: '#c66b3d', roughness: 0.78, metalness: 0.04, opacity: 1,
};

export function cloneDocument(doc: AssetDocument): AssetDocument {
  return structuredClone(doc);
}

export function blankDocument(name = 'Untitled asset'): AssetDocument {
  return { version: ASSET_DOCUMENT_VERSION, name, parts: [] };
}

export function nextPartId(doc: AssetDocument): string {
  let i = doc.parts.length + 1;
  while (doc.parts.some((part) => part.id === `part-${i}`)) i++;
  return `part-${i}`;
}

export function createPart(doc: AssetDocument, kind: PrimitiveKind): AssetPart {
  const id = nextPartId(doc);
  const geometry: PartGeometry = kind === 'box'
    ? { kind, size: [1, 1, 1] }
    : kind === 'cylinder'
      ? { kind, radiusTop: 0.5, radiusBottom: 0.5, height: 1, segments: 10 }
      : kind === 'cone'
        ? { kind, radius: 0.55, height: 1.2, segments: 8 }
        : kind === 'sphere'
          ? { kind, radius: 0.6, detail: 1 }
          : kind === 'torus'
            ? { kind, radius: 0.55, tube: 0.14, radialSegments: 8, tubularSegments: 16 }
            : { kind, size: [1, 1] };
  return {
    id,
    name: `${kind[0]!.toUpperCase()}${kind.slice(1)} ${doc.parts.length + 1}`,
    geometry,
    transform: {
      position: [0, kind === 'plane' ? 0.01 : 0.5, 0],
      rotation: kind === 'plane' ? [-Math.PI / 2, 0, 0] : [0, 0, 0],
      scale: [1, 1, 1],
    },
    material: { ...DEFAULT_MATERIAL },
  };
}

function finiteNumber(value: unknown, label: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function tuple(value: unknown, label: string, positive = false): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} must contain three numbers`);
  return value.map((entry, i) => finiteNumber(entry, `${label}[${i}]`, positive ? 0.001 : -10000, 10000)) as Vec3;
}

function geometry(value: unknown, label: string): PartGeometry {
  if (!value || typeof value !== 'object') throw new Error(`${label} is missing`);
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (kind === 'box') return { kind, size: tuple(raw.size, `${label}.size`, true) };
  if (kind === 'cylinder') return {
    kind,
    radiusTop: finiteNumber(raw.radiusTop, `${label}.radiusTop`, 0, 1000),
    radiusBottom: finiteNumber(raw.radiusBottom, `${label}.radiusBottom`, 0, 1000),
    height: finiteNumber(raw.height, `${label}.height`, 0.001, 1000),
    segments: Math.round(finiteNumber(raw.segments, `${label}.segments`, 3, 64)),
  };
  if (kind === 'cone') return {
    kind,
    radius: finiteNumber(raw.radius, `${label}.radius`, 0.001, 1000),
    height: finiteNumber(raw.height, `${label}.height`, 0.001, 1000),
    segments: Math.round(finiteNumber(raw.segments, `${label}.segments`, 3, 64)),
  };
  if (kind === 'sphere') return {
    kind,
    radius: finiteNumber(raw.radius, `${label}.radius`, 0.001, 1000),
    detail: Math.round(finiteNumber(raw.detail, `${label}.detail`, 0, 4)),
  };
  if (kind === 'torus') return {
    kind,
    radius: finiteNumber(raw.radius, `${label}.radius`, 0.001, 1000),
    tube: finiteNumber(raw.tube, `${label}.tube`, 0.001, 1000),
    radialSegments: Math.round(finiteNumber(raw.radialSegments, `${label}.radialSegments`, 3, 32)),
    tubularSegments: Math.round(finiteNumber(raw.tubularSegments, `${label}.tubularSegments`, 3, 64)),
  };
  if (kind === 'plane') {
    if (!Array.isArray(raw.size) || raw.size.length !== 2) throw new Error(`${label}.size must contain two numbers`);
    return { kind, size: [
      finiteNumber(raw.size[0], `${label}.size[0]`, 0.001, 1000),
      finiteNumber(raw.size[1], `${label}.size[1]`, 0.001, 1000),
    ] };
  }
  throw new Error(`${label}.kind is not a supported primitive`);
}

export function decodeAssetDocument(value: unknown): AssetDocument {
  if (!value || typeof value !== 'object') throw new Error('Asset file must contain an object');
  const raw = value as Record<string, unknown>;
  if (raw.version !== ASSET_DOCUMENT_VERSION) throw new Error(`Unsupported asset version: ${String(raw.version)}`);
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 100) {
    throw new Error('Asset name must be between 1 and 100 characters');
  }
  if (!Array.isArray(raw.parts) || raw.parts.length > 1000) throw new Error('Asset parts must be an array of at most 1000 items');
  const ids = new Set<string>();
  const parts = raw.parts.map((entry, index): AssetPart => {
    if (!entry || typeof entry !== 'object') throw new Error(`parts[${index}] must be an object`);
    const part = entry as Record<string, unknown>;
    if (typeof part.id !== 'string' || !part.id || part.id.length > 100 || ids.has(part.id)) {
      throw new Error(`parts[${index}].id must be short and unique`);
    }
    ids.add(part.id);
    if (typeof part.name !== 'string' || !part.name.trim() || part.name.length > 100) {
      throw new Error(`parts[${index}].name must be between 1 and 100 characters`);
    }
    const transform = part.transform as Record<string, unknown> | undefined;
    const material = part.material as Record<string, unknown> | undefined;
    if (!transform || !material) throw new Error(`parts[${index}] is missing transform or material`);
    if (typeof material.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(material.color)) {
      throw new Error(`parts[${index}].material.color must be a hex colour`);
    }
    return {
      id: part.id,
      name: part.name,
      geometry: geometry(part.geometry, `parts[${index}].geometry`),
      transform: {
        position: tuple(transform.position, `parts[${index}].transform.position`),
        rotation: tuple(transform.rotation, `parts[${index}].transform.rotation`),
        scale: tuple(transform.scale, `parts[${index}].transform.scale`, true),
      },
      material: {
        color: material.color.toLowerCase(),
        roughness: finiteNumber(material.roughness, `parts[${index}].material.roughness`, 0, 1),
        metalness: finiteNumber(material.metalness, `parts[${index}].material.metalness`, 0, 1),
        opacity: finiteNumber(material.opacity, `parts[${index}].material.opacity`, 0.05, 1),
      },
    };
  });
  return { version: ASSET_DOCUMENT_VERSION, name: raw.name.trim(), parts };
}

export function fileSafeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'asset';
}
