import * as THREE from 'three';
import type { AssetPart, PartGeometry } from './document.js';

export function makeGeometry(spec: PartGeometry): THREE.BufferGeometry {
  switch (spec.kind) {
    case 'box': return new THREE.BoxGeometry(...spec.size);
    case 'cylinder': return new THREE.CylinderGeometry(
      spec.radiusTop, spec.radiusBottom, spec.height, spec.segments,
    );
    case 'cone': return new THREE.ConeGeometry(spec.radius, spec.height, spec.segments);
    case 'sphere': return new THREE.IcosahedronGeometry(spec.radius, spec.detail);
    case 'torus': return new THREE.TorusGeometry(
      spec.radius, spec.tube, spec.radialSegments, spec.tubularSegments,
    );
    case 'plane': return new THREE.PlaneGeometry(...spec.size);
  }
}

export function makePartMesh(part: AssetPart): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({
    color: part.material.color,
    roughness: part.material.roughness,
    metalness: part.material.metalness,
    transparent: part.material.opacity < 1,
    opacity: part.material.opacity,
    side: part.geometry.kind === 'plane' ? THREE.DoubleSide : THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(makeGeometry(part.geometry), material);
  mesh.name = part.name;
  mesh.userData.assetPartId = part.id;
  mesh.position.fromArray(part.transform.position);
  mesh.rotation.order = 'XYZ';
  mesh.rotation.fromArray([...part.transform.rotation, 'XYZ']);
  mesh.scale.fromArray(part.transform.scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
