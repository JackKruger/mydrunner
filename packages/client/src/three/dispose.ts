// GPU resource cleanup helpers.
//
// Three.js frees nothing on scene.remove(): geometries, materials and
// textures all stay resident until explicitly disposed. Every place that
// tears down part of the scene graph needs these, so they live here rather
// than private to whichever module needed them first.

import * as THREE from 'three';

/** Recursively free the GPU resources under an Object3D. Without this
 *  every departed player leaked their car mesh's buffers for the tab's
 *  life, and every terrain rebuild leaked the obstacle group. */
export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) for (const m of mat) disposeMaterial(m);
    else if (mat) disposeMaterial(mat);
  });
}

/** Material.dispose() does NOT free the textures a material references,
 *  so a material-only dispose leaks every map it points at - notably the
 *  canvas texture behind each nameplate sprite. */
export function disposeMaterial(mat: THREE.Material): void {
  const m = mat as THREE.Material & {
    map?: THREE.Texture | null;
    normalMap?: THREE.Texture | null;
    emissiveMap?: THREE.Texture | null;
  };
  m.map?.dispose();
  m.normalMap?.dispose();
  m.emissiveMap?.dispose();
  mat.dispose();
}
