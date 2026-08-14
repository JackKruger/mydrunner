// Fitted procedural meshes for the fictional Australian 4x4 bases.
// Geometry follows the resolved build, while wheel groups stay parented to
// the physics-driven solid axles. These meshes are intentionally free of
// manufacturer badges and double as the asset-load failure fallback.

import * as THREE from 'three';
import {
  Physics,
  TUNING,
  createStockBuild,
  normalizeVehicleBaseId,
  normalizeVehicleBuild,
  type CarKind,
  type PaintFinish,
  type VehicleBuild,
} from '@mydrunner/shared';
import {
  createVehicleVisualLayout,
  type VehicleVisualLayout,
  type VisualBox,
} from './vehicleVisualLayout.js';
import { buildSuspensionVisual, type SuspensionVisual } from './suspensionVisual.js';
import { activeQuality } from './quality.js';

type Extents = { x: number; y: number; z: number };

export interface CarMesh {
  group: THREE.Group;
  /** [FL, FR, RL, RR]. Spin + steer apply here. Each wheel is a child
   *  of its axle group (axles[0] for FL/FR, axles[1] for RL/RR), so
   *  posing the axle moves both wheels together - that's the solid-axle
   *  rigid-beam coupling. */
  wheels: THREE.Object3D[];
  tires: TireDeformer[];
  /** [front, rear] axle groups. Each is positioned at chassis-local
   *  (0, centerLocalY + rideY, centerLocalZ) and rotated by rollAngle
   *  about chassis-forward (local +Z). Wheel meshes are children at
   *  (+/- trackHalf, 0, 0). */
  axles: [THREE.Group, THREE.Group];
  /** Visual-only locating links, springs and dampers driven by axle pose. */
  suspension: SuspensionVisual;
  recovery: {
    fairlead: THREE.Object3D;
    front: THREE.Object3D;
    rear: THREE.Object3D;
  };
  /** Cosmetic accumulation only; authoritative handling remains in physics. */
  updateDirt(dtSeconds: number, mudContact: number, waterContact: number): void;
}

export interface TireDeformer {
  mesh: THREE.Mesh;
  /** Normal is expressed in the spinning wheel group's local frame. */
  update(deflection: number, normal: THREE.Vector3): void;
}

interface Materials {
  body: THREE.MeshPhysicalMaterial;
  trim: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  black: THREE.MeshStandardMaterial;
  dirt: { value: number };
  rubberDetail: THREE.Texture;
}

function detailTexture(name: string, repeat: number, color = false): THREE.Texture {
  const texture = new THREE.TextureLoader().load(`/assets/materials/${name}`);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function meshForBox(spec: VisualBox, material: THREE.Material, name?: string): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(spec.size.x, spec.size.y, spec.size.z),
    material,
  );
  mesh.position.set(spec.center.x, spec.center.y, spec.center.z);
  if (spec.rotationX !== undefined) mesh.rotation.x = spec.rotationX;
  if (name) mesh.name = name;
  return mesh;
}

function addTube(
  group: THREE.Group,
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  name: string,
): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(to, from);
  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, direction.length(), 10),
    material,
  );
  tube.name = name;
  tube.position.copy(from).add(to).multiplyScalar(0.5);
  tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  tube.castShadow = true;
  group.add(tube);
  return tube;
}

function makeMaterials(bodyColor: number, finish: PaintFinish = 'gloss'): Materials {
  const roughness = finish === 'matte' ? 0.9 : finish === 'satin' ? 0.66 : 0.42;
  const metalness = finish === 'matte' ? 0.02 : 0.15;
  const dirt = { value: 0 };
  const paintDetail = detailTexture('painted-metal-detail.svg', 5);
  const glassVariation = detailTexture('glass-imperfections.svg', 3);
  const rubberDetail = detailTexture('rubber-detail.svg', 7);
  const body = new THREE.MeshPhysicalMaterial({
    color: bodyColor, roughness, metalness, name: 'paint.primary',
    normalMap: paintDetail, normalScale: new THREE.Vector2(0.07, 0.07),
    clearcoat: finish === 'gloss' ? 0.82 : finish === 'satin' ? 0.35 : 0.04,
    clearcoatRoughness: finish === 'gloss' ? 0.16 : finish === 'satin' ? 0.38 : 0.75,
  });
  body.onBeforeCompile = (shader) => {
    shader.uniforms.vehicleDirt = dirt;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vehicleLocalPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvehicleLocalPosition = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float vehicleDirt;\nvarying vec3 vehicleLocalPosition;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float dirtLower = 1.0 - smoothstep(0.05, 1.15, vehicleLocalPosition.y);
        float dirtRear = smoothstep(0.15, 1.4, -vehicleLocalPosition.z);
        float dirtNoise = 0.72 + 0.28 * sin(vehicleLocalPosition.x * 19.0 + vehicleLocalPosition.z * 13.0);
        float dirtMask = clamp(max(dirtLower, dirtRear * 0.58) * dirtNoise * vehicleDirt, 0.0, 0.88);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.19, 0.105, 0.045), dirtMask);`);
  };
  body.customProgramCacheKey = () => 'vehicle-paint-detail-dirt-v2';
  return {
    body,
    trim: new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.85, metalness: 0 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x29343d,
      roughness: 0.18,
      metalness: 0.08,
      transparent: true,
      opacity: 0.72,
      roughnessMap: glassVariation,
    }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.35, metalness: 0.7 }),
    black: new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.6 }),
    dirt,
    rubberDetail,
  };
}

function deformableTireMaterial(
  r: number,
  w: number,
  dirt: { value: number },
  rubberDetail?: THREE.Texture,
): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial; distance: THREE.MeshDistanceMaterial; uniforms: { deflection: { value: number }; normal: { value: THREE.Vector3 }; shoulderBulge: { value: number } } } {
  const uniforms = {
    deflection: { value: 0 },
    normal: { value: new THREE.Vector3(0, 1, 0) },
    shoulderBulge: { value: 1 },
  };
  const vertexPatch = `
    float tirePlane = -${r.toFixed(7)} + tireDeflection;
    float tireAlongNormal = dot(transformed, tireContactNormal);
    if (tireAlongNormal < tirePlane) {
      transformed += tireContactNormal * (tirePlane - tireAlongNormal);
    }
    vec3 tireAxial = vec3(transformed.x, 0.0, 0.0);
    vec3 tireRadial = transformed - tireAxial;
    float tireRadialLen = length(tireRadial);
    float tirePatch = smoothstep(-${r.toFixed(7)}, tirePlane + tireDeflection * 2.5, tireAlongNormal);
    float tireShoulder = smoothstep(0.55, 1.0, abs(transformed.x) / max(0.001, ${Math.max(0.001, w * 0.5).toFixed(7)}));
    if (tireRadialLen > 0.0001) {
      transformed += tireRadial / tireRadialLen * tireDeflection * 0.16 * tireShoulderBulge * tirePatch * tireShoulder;
    }
  `;
  const hook = (shader: THREE.WebGLProgramParametersWithUniforms, treadPattern = false): void => {
    shader.uniforms.tireDeflection = uniforms.deflection;
    shader.uniforms.tireContactNormal = uniforms.normal;
    shader.uniforms.tireShoulderBulge = uniforms.shoulderBulge;
    shader.uniforms.vehicleDirt = dirt;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float tireDeflection;\nuniform vec3 tireContactNormal;\nuniform float tireShoulderBulge;${treadPattern ? '\nvarying vec3 tireRestPosition;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${treadPattern ? 'tireRestPosition = position;' : ''}\n${vertexPatch}`);
    if (treadPattern) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 tireRestPosition;\nuniform float vehicleDirt;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float tireAngle = atan(tireRestPosition.z, tireRestPosition.y);
          float tireBlocks = step(0.46, fract(tireAngle * 1.2732395 + tireRestPosition.x * 5.0));
          float sidewall = smoothstep(0.58, 0.96, abs(tireRestPosition.x) / ${Math.max(0.001, w * .5).toFixed(7)});
          diffuseColor.rgb *= mix(0.76, 1.08, tireBlocks);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.085, 0.035), vehicleDirt * (0.46 + sidewall * 0.38));`);
    }
  };
  const material = new THREE.MeshStandardMaterial({
    color: 0x0e0e0e, roughness: 0.95, normalMap: rubberDetail,
    normalScale: new THREE.Vector2(0.16, 0.16),
  });
  material.onBeforeCompile = (shader) => hook(shader, true);
  material.customProgramCacheKey = () => 'directional-tire-v1';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => hook(shader);
  depth.customProgramCacheKey = () => 'directional-tire-depth-v1';
  const distance = new THREE.MeshDistanceMaterial();
  distance.onBeforeCompile = (shader) => hook(shader);
  distance.customProgramCacheKey = () => 'directional-tire-distance-v1';
  return { material, depth, distance, uniforms };
}

function buildSingleWheel(r: number, w: number, build?: VehicleBuild, dirt = { value: 0 }, rubberDetail?: THREE.Texture): { group: THREE.Group; tire: TireDeformer } {
  const tireGeo = new THREE.CylinderGeometry(r, r, w, activeQuality().tireSegments, 8);
  tireGeo.rotateZ(Math.PI / 2);
  // Round the carcass shoulders while retaining a broad tread belt.
  const positions = tireGeo.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    const radial = Math.hypot(y, z);
    if (radial < r * 0.75) continue; // keep cap interiors planar
    const edge = Math.min(1, Math.abs(x) / Math.max(0.001, w * 0.5));
    const shoulder = Math.max(0, (edge - 0.62) / 0.38);
    const roundedRadius = r * (1 - 0.055 * shoulder * shoulder);
    const scale = roundedRadius / Math.max(1e-6, radial);
    positions.setY(i, y * scale);
    positions.setZ(i, z * scale);
  }
  positions.needsUpdate = true;
  tireGeo.computeVertexNormals();
  const tireShader = deformableTireMaterial(r, w, dirt, rubberDetail);
  const rimGeo = new THREE.CylinderGeometry(r * 0.6, r * 0.6, w + 0.02, 14);
  rimGeo.rotateZ(Math.PI / 2);
  const steel = build?.wheelId.endsWith('.classic-steel') || build?.wheelId.endsWith('.reinforced-rally-steel') || false;
  const beadlock = build?.wheelId.endsWith('.beadlock-alloy') ?? false;
  const periodAlloy = build?.wheelId.endsWith('.period-alloy') ?? false;
  const rimMat = new THREE.MeshStandardMaterial({
    color: steel ? 0x292b2d : beadlock ? 0x555b60 : periodAlloy ? 0xd1d0c7 : 0x9aa0a6,
    roughness: steel ? 0.72 : periodAlloy ? 0.32 : 0.4,
    metalness: 0.7,
  });
  const hubGeo = new THREE.CylinderGeometry(r * 0.18, r * 0.18, w + 0.04, 8);
  hubGeo.rotateZ(Math.PI / 2);
  const hubMat = new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.8 });
  const spokeGeo = new THREE.BoxGeometry(w + 0.005, r * 0.55, 0.05);
  const wheelGroup = new THREE.Group();
  // YXZ rotation order so the renderer composes turn-then-roll correctly:
  // rotation.y is applied AFTER rotation.x, meaning the wheel rolls around
  // its own axle FIRST, then turns. With the default XYZ order, a spinning
  // wheel that's also steered tumbles around the world X axis (visibly
  // shaking when driving + turning).
  wheelGroup.rotation.order = 'YXZ';
  const tire = new THREE.Mesh(tireGeo, tireShader.material);
  tire.name = 'wheel.deformableCarcass';
  tire.castShadow = true;
  tire.customDepthMaterial = tireShader.depth;
  tire.customDistanceMaterial = tireShader.distance;
  wheelGroup.add(tire);
  wheelGroup.add(new THREE.Mesh(rimGeo, rimMat));
  wheelGroup.add(new THREE.Mesh(hubGeo, hubMat));
  if (beadlock) {
    const ringGeo = new THREE.TorusGeometry(r * 0.54, 0.025, 8, 24);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshStandardMaterial({ color: 0xb7a476, roughness: 0.45, metalness: 0.75 }));
    ring.rotation.y = Math.PI / 2;
    ring.position.x = w * 0.51;
    wheelGroup.add(ring);
  }
  const spokeCount = 5;
  for (let s = 0; s < spokeCount; s++) {
    const spoke = new THREE.Mesh(spokeGeo, rimMat);
    spoke.rotation.x = (s / spokeCount) * Math.PI * 2;
    wheelGroup.add(spoke);
  }
  let renderedDeflection = 0;
  return {
    group: wheelGroup,
    tire: {
      mesh: tire,
      update(deflection, normal) {
        const visualTarget = Math.max(0, deflection) * TUNING.tireVisualDeformationMult;
        renderedDeflection += (visualTarget - renderedDeflection) * 0.24;
        tireShader.uniforms.deflection.value = renderedDeflection;
        tireShader.uniforms.normal.value.copy(normal).normalize();
        tireShader.uniforms.shoulderBulge.value = TUNING.tireShoulderBulgeMult;
      },
    },
  };
}

/** Build the two solid-axle assemblies and attach them to the chassis
 *  group. Each axle is a child Group containing a beam + diff pumpkin
 *  + left wheel + right wheel. The axle group is the unit posed by
 *  scene.ts each frame using rideY (vertical) and rollAngle (twist
 *  about chassis-forward) - the rigid-beam articulation is the visual
 *  signature of solid-axle 4x4s. Wheels are at fixed local +/- trackHalf
 *  inside the axle group, so steering and spin still apply per-wheel
 *  while the axle itself moves them as one unit. */
function buildAxles(group: THREE.Group, build: VehicleBuild, dirt: { value: number }, rubberDetail: THREE.Texture): {
  axles: [THREE.Group, THREE.Group];
  wheels: THREE.Object3D[];
  tires: TireDeformer[];
} {
  const geom = Physics.geomFor(build);
  const axles: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  const wheels: THREE.Object3D[] = [];
  const tires: TireDeformer[] = [];

  const beamMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
  const diffMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.75, metalness: 0.2 });

  for (let aIdx = 0; aIdx < 2; aIdx++) {
    const ag = aIdx === 0 ? geom.front : geom.rear;
    const axle = axles[aIdx]!;
    // Initial pose at rest. The axle BEAM sits at wheel-centre height in
    // chassis frame, which is the chassis attachment (centerLocalY) minus
    // the spring rest length. As the spring compresses (rideY > 0) the
    // beam moves UP toward the attachment; that's what scene.ts applies
    // each frame from the physics axle state.
    axle.position.set(0, ag.centerLocalY - ag.suspensionRestLength, ag.centerLocalZ);

    {
      // Beam: thin cylinder along chassis-X. Slightly shorter than full
      // track so the wheel hubs visually overlap the beam ends.
      const beamLen = ag.trackHalf * 2 - 0.18;
      const beamRad = 0.07;
      const beamGeo = new THREE.CylinderGeometry(beamRad, beamRad, beamLen, 12);
      beamGeo.rotateZ(Math.PI / 2);
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.castShadow = true;
      axle.add(beam);

      // Diff pumpkin: a rounded housing at the centre of the beam, slightly
      // offset toward the chassis side that historically housed the diff
      // (rear axle = forward of centre). Pure visual identifier.
      const diffSize = aIdx === 0 ? { x: 0.34, y: 0.30, z: 0.34 } : { x: 0.36, y: 0.32, z: 0.36 };
      const diffGeo = new THREE.SphereGeometry(0.5, 16, 12);
      const diff = new THREE.Mesh(diffGeo, diffMat);
      diff.name = `axle.${aIdx === 0 ? 'front' : 'rear'}.differential`;
      diff.scale.set(diffSize.x, diffSize.y, diffSize.z);
      diff.position.set(0, 0, aIdx === 0 ? 0 : 0.04);
      diff.castShadow = true;
      axle.add(diff);
    }

    // Two wheels at the beam ends.
    const wheelXOffset = ag.trackHalf;
    const wheelW = geom.wheelWidth;
    for (let side = 0; side < 2; side++) {
      const builtWheel = buildSingleWheel(geom.wheelRadius, wheelW, build, dirt, rubberDetail);
      const wheel = builtWheel.group;
      wheel.position.set(side === 0 ? -wheelXOffset : +wheelXOffset, 0, 0);
      axle.add(wheel);
      wheels.push(wheel);
      tires.push(builtWheel.tire);
    }

    group.add(axle);
  }

  return { axles, wheels, tires };
}

function buildLowerBodyAndFlares(
  group: THREE.Group,
  ext: Extents,
  mats: Materials,
  build: VehicleBuild,
): void {
  // Lower body: full chassis box.
  const lower = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 2, ext.y * 2, ext.z * 2), mats.body);
  lower.castShadow = true;
  lower.receiveShadow = true;
  group.add(lower);

  // Black plastic trim band along the bottom 1/4.
  const bandH = ext.y * 0.5;
  const band = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 2.02, bandH, ext.z * 2.02), mats.trim);
  band.position.set(0, -ext.y + bandH / 2, 0);
  group.add(band);

  // Wheel flares around each wheel position. Driven from the per-kind
  // axle geometry so flares track each base's wheelbase changes.
  for (const wp of Physics.restWheelPositions(build)) {
    const flare = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.85), mats.trim);
    flare.position.set(Math.sign(wp.x) * (ext.x + 0.02), -ext.y + 0.1, wp.z);
    group.add(flare);
  }
}

function addCabin(group: THREE.Group, layout: VehicleVisualLayout, mats: Materials): void {
  const cabin = meshForBox({ center: layout.cabin.center, size: layout.cabin.size }, mats.body, 'body.cabin');
  cabin.castShadow = true;
  group.add(cabin);

  for (let index = 0; index < layout.cabin.sideWindows.length; index++) {
    group.add(meshForBox(layout.cabin.sideWindows[index]!, mats.glass, `glass.side.${index}`));
  }
  group.add(meshForBox(layout.cabin.windshield, mats.glass, 'glass.windshield'));
  group.add(meshForBox(layout.cabin.rearWindow, mats.glass, 'glass.rear'));
}

function buildWagonBody(group: THREE.Group, layout: VehicleVisualLayout, mats: Materials): void {
  const ext = layout.extents;
  addCabin(group, layout, mats);

  // Round headlights and a simple factory bumper.
  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff4d2, emissive: 0xffd070, emissiveIntensity: 0.6 });
  for (const sign of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.06, 14), headlightMat);
    hl.rotation.x = Math.PI / 2;
    hl.position.set(sign * ext.x * 0.55, -ext.y * 0.05, ext.z + 0.04);
    group.add(hl);
  }
  // Vertical chrome grille slats.
  for (let i = -2; i <= 2; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(0.035, ext.y * 0.45, 0.04), mats.chrome);
    slat.position.set(i * 0.07, -ext.y * 0.05, ext.z + 0.025);
    group.add(slat);
  }
  // Tall vertical tail lights.
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xa31818, emissive: 0xa31818, emissiveIntensity: 0.4 });
  for (const sign of [-1, 1]) {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.18, ext.y * 0.85, 0.04), tailMat);
    tl.position.set(sign * ext.x * 0.78, ext.y * 0.1, -ext.z - 0.03);
    group.add(tl);
  }
}

function buildUtilityBody(group: THREE.Group, layout: VehicleVisualLayout, mats: Materials): void {
  const ext = layout.extents;
  const tray = layout.tray!;
  addCabin(group, layout, mats);

  // Tray bed: low side walls along the rear half of the body (where the cabin
  // doesn't sit). The lower body box already provides the floor and outer
  // sides - these walls are the bed sidewalls that frame the canopy.
  const bedWallY = ext.y + tray.wallHeight / 2;
  // Bed front wall (against cabin back).
  const bedFront = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.92, tray.wallHeight, 0.06), mats.body);
  bedFront.position.set(0, bedWallY, tray.frontZ - 0.03);
  group.add(bedFront);
  // Tailgate at the rear.
  const tailgate = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.92, tray.wallHeight * 0.95, 0.06), mats.body);
  tailgate.position.set(0, bedWallY - tray.wallHeight * 0.025, tray.rearZ + 0.03);
  group.add(tailgate);
  // Side bed walls.
  for (const sign of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.06, tray.wallHeight, tray.length), mats.body);
    wall.position.set(sign * ext.x * 0.96, bedWallY, tray.centerZ);
    group.add(wall);
  }

  // Rectangular headlights tucked into the front fenders.
  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff4d2, emissive: 0xffd070, emissiveIntensity: 0.55 });
  for (const sign of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.04), headlightMat);
    hl.position.set(sign * ext.x * 0.55, ext.y * 0.05, ext.z + 0.025);
    group.add(hl);
  }
  // Wide chrome grille bar between the headlights.
  const grille = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 0.95, 0.1, 0.04), mats.chrome);
  grille.position.set(0, -ext.y * 0.05, ext.z + 0.025);
  group.add(grille);
  // Horizontal tail lights low on the tailgate.
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xa31818, emissive: 0xa31818, emissiveIntensity: 0.4 });
  for (const sign of [-1, 1]) {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.04), tailMat);
    tl.position.set(sign * ext.x * 0.6, ext.y * 0.6, tray.rearZ - 0.04);
    group.add(tl);
  }
}

function buildRallyBody(group: THREE.Group, layout: VehicleVisualLayout, mats: Materials, build: VehicleBuild): void {
  const ext = layout.extents;
  const lower = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 2, ext.y * 2, ext.z * 2), mats.body);
  lower.name = 'rally.lowerBody';
  lower.castShadow = true;
  lower.receiveShadow = true;
  group.add(lower);
  addCabin(group, layout, mats);

  const bumperFront = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.94, 0.13, 0.12), mats.trim);
  bumperFront.name = 'rally.frontBumper';
  bumperFront.position.set(0, -ext.y * 0.42, ext.z + 0.07);
  group.add(bumperFront);
  const bumperRear = bumperFront.clone();
  bumperRear.name = 'rally.rearBumper';
  bumperRear.position.z = -ext.z - 0.07;
  group.add(bumperRear);

  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff2c8, emissive: 0xffca62, emissiveIntensity: 0.65 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xa51616, emissive: 0x8a0c0c, emissiveIntensity: 0.45 });
  for (const side of [-1, 1]) {
    const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.18, 0.045), lampMat);
    headlight.name = `rally.squareLamp.${side}`;
    headlight.position.set(side * ext.x * 0.52, ext.y * 0.12, ext.z + 0.025);
    group.add(headlight);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.22, 0.045), tailMat);
    tail.name = `rally.tailLamp.${side}`;
    tail.position.set(side * ext.x * 0.68, ext.y * 0.14, -ext.z - 0.025);
    group.add(tail);

    for (const wp of Physics.restWheelPositions(build)) {
      if (Math.sign(wp.x) !== side) continue;
      const flare = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.16, 0.68), mats.trim);
      flare.name = `rally.flare.${side}.${wp.z > 0 ? 'front' : 'rear'}`;
      flare.position.set(side * (ext.x + 0.035), -ext.y * 0.42, wp.z);
      group.add(flare);
      const flap = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.32, 0.20), mats.black);
      flap.name = `rally.mudFlap.${side}.${wp.z > 0 ? 'front' : 'rear'}`;
      flap.position.set(side * (ext.x + 0.02), -ext.y - 0.14, wp.z - 0.30);
      group.add(flap);
    }
  }

  const grille = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 0.54, 0.13, 0.04), mats.black);
  grille.name = 'rally.grille';
  grille.position.set(0, ext.y * 0.03, ext.z + 0.025);
  group.add(grille);
  const hatchSeam = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.45, 0.025, 0.025), mats.trim);
  hatchSeam.name = 'rally.hatchSeam';
  hatchSeam.position.set(0, layout.cabin.rearWindow.center.y - layout.cabin.rearWindow.size.y * 0.62, -ext.z - 0.014);
  group.add(hatchSeam);
}

function buildCrawlerBody(group: THREE.Group, layout: VehicleVisualLayout, mats: Materials): void {
  const ext = layout.extents;
  const cageRadius = 0.045;
  const lowerY = -ext.y * 0.48;
  const shoulderY = ext.y + 0.18;
  const roofY = layout.cabin.roofY;
  const lowerX = ext.x * 0.83;
  const roofX = layout.cabin.size.x * 0.48;
  const frontZ = layout.cabin.frontZ;
  const rearZ = layout.cabin.rearZ;

  const skid = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.42, 0.16, ext.z * 1.20), mats.black);
  skid.name = 'crawler.skid';
  skid.position.set(0, -ext.y * 0.48, 0);
  skid.castShadow = true;
  group.add(skid);

  const engine = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.22, 0.48, ext.z * 0.52), mats.trim);
  engine.name = 'crawler.engine';
  engine.position.set(0, ext.y * 0.25, ext.z * 0.54);
  engine.castShadow = true;
  group.add(engine);

  const hood = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.48, 0.09, ext.z * 0.52), mats.body);
  hood.name = 'crawler.hood';
  hood.position.set(0, ext.y * 0.98, ext.z * 0.56);
  hood.rotation.x = -0.07;
  hood.castShadow = true;
  group.add(hood);

  for (const side of [-1, 1]) {
    const x0 = side * lowerX;
    const x1 = side * roofX;
    const lowerFront = new THREE.Vector3(x0, lowerY, ext.z * 0.72);
    const lowerRear = new THREE.Vector3(x0, lowerY, -ext.z * 0.72);
    const shoulderFront = new THREE.Vector3(x0, shoulderY, frontZ);
    const shoulderRear = new THREE.Vector3(x0, shoulderY, rearZ);
    const roofFront = new THREE.Vector3(x1, roofY, frontZ * 0.82);
    const roofRear = new THREE.Vector3(x1, roofY, rearZ * 0.88);

    addTube(group, lowerFront, lowerRear, 0.055, mats.body, `crawler.rockRail.${side}`);
    addTube(group, lowerFront, shoulderFront, cageRadius, mats.body, `crawler.frontStay.${side}`);
    addTube(group, shoulderFront, roofFront, cageRadius, mats.body, `crawler.apillar.${side}`);
    addTube(group, roofFront, roofRear, cageRadius, mats.body, `crawler.roofRail.${side}`);
    addTube(group, roofRear, shoulderRear, cageRadius, mats.body, `crawler.bpillar.${side}`);
    addTube(group, shoulderRear, lowerRear, cageRadius, mats.body, `crawler.rearStay.${side}`);
    addTube(group, shoulderFront, shoulderRear, cageRadius, mats.body, `crawler.doorBar.${side}`);
    addTube(group, lowerFront, shoulderRear, 0.038, mats.body, `crawler.sideBrace.${side}`);
    addTube(
      group,
      lowerRear,
      new THREE.Vector3(side * ext.x * 0.62, ext.y * 0.08, -ext.z * 0.96),
      cageRadius,
      mats.body,
      `crawler.rearKickup.${side}`,
    );
  }

  for (const [name, y, z, width] of [
    ['dash', shoulderY, frontZ, lowerX],
    ['roofFront', roofY, frontZ * 0.82, roofX],
    ['roofRear', roofY, rearZ * 0.88, roofX],
    ['rear', shoulderY, rearZ, lowerX],
  ] as const) {
    addTube(
      group,
      new THREE.Vector3(-width, y, z),
      new THREE.Vector3(width, y, z),
      cageRadius,
      mats.body,
      `crawler.crossbar.${name}`,
    );
  }
  addTube(
    group,
    new THREE.Vector3(-roofX, roofY, frontZ * 0.82),
    new THREE.Vector3(roofX, roofY, rearZ * 0.88),
    0.035,
    mats.body,
    'crawler.roofDiagonal',
  );

  group.add(meshForBox(layout.dashboard, mats.trim, 'interior.dashboard'));
  for (let index = 0; index < layout.seats.length; index++) {
    const seat = meshForBox(layout.seats[index]!, mats.black, `interior.seat.${index}`);
    seat.rotation.x = -0.12;
    group.add(seat);
  }

  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xffefd0, emissive: 0xffc45c, emissiveIntensity: 0.8 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xb01818, emissive: 0x8a0e0e, emissiveIntensity: 0.55 });
  for (const side of [-1, 1]) {
    const headlight = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.07, 14), headlightMat);
    headlight.name = `crawler.headlight.${side}`;
    headlight.rotation.x = Math.PI / 2;
    headlight.position.set(side * ext.x * 0.48, ext.y * 0.64, ext.z * 0.83);
    group.add(headlight);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.05), tailMat);
    tail.name = `crawler.tailLight.${side}`;
    tail.position.set(side * ext.x * 0.63, ext.y * 0.12, -ext.z * 0.94);
    group.add(tail);
  }
}

function addSharedDetail(
  group: THREE.Group,
  layout: VehicleVisualLayout,
  mats: Materials,
  build: VehicleBuild,
): void {
  const ext = layout.extents;
  const seamMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  // Door/panel seams and sill rails make the silhouette read at close range.
  for (const side of [-1, 1]) {
    const seams = layout.style === 'rally' ? [layout.cabin.frontZ - layout.cabin.size.z * 0.48] : [-ext.z * 0.35, ext.z * 0.35];
    for (const z of seams) {
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.018, ext.y * 1.35, 0.025), seamMat);
      seam.name = layout.style === 'rally' ? `rally.doorSeam.${side}` : 'body.doorSeam';
      seam.position.set(side * (ext.x + 0.011), ext.y * 0.75, z);
      group.add(seam);
    }
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.28), mats.trim);
    mirror.position.set(
      side * (layout.cabin.size.x / 2 + 0.12),
      layout.cabin.windshield.center.y - layout.cabin.windshield.size.y * 0.28,
      layout.cabin.frontZ - 0.16,
    );
    group.add(mirror);
  }
  // Lightweight seats and dashboard remain visible through the glass.
  group.add(meshForBox(layout.dashboard, mats.trim, 'interior.dashboard'));
  for (let index = 0; index < layout.seats.length; index++) {
    group.add(meshForBox(layout.seats[index]!, mats.black, `interior.seat.${index}`));
  }
  group.userData.vehicleBuild = build;
  group.userData.vehicleVisualLayout = layout;
}

function addBaseCharacter(
  group: THREE.Group,
  layout: VehicleVisualLayout,
  mats: Materials,
  build: VehicleBuild,
): void {
  const ext = layout.extents;
  const trim = mats.trim;
  if (build.baseId === 'overlander') {
    const belt = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 2.04, 0.07, ext.z * 1.55), trim);
    belt.position.set(0, ext.y * 1.1, -ext.z * 0.12);
    group.add(belt);
  } else if (build.baseId === 'stockman-single') {
    const headboard = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.82, 0.08, 0.08), mats.chrome);
    headboard.position.set(0, ext.y + layout.tray!.wallHeight, layout.tray!.frontZ - 0.05);
    group.add(headboard);
  } else if (build.baseId === 'longreach') {
    for (const side of [-1, 1]) {
      const cargoWindow = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.50, ext.z * 0.52), mats.glass);
      cargoWindow.position.set(
        side * (layout.cabin.size.x / 2 + 0.0125),
        layout.cabin.center.y,
        layout.cabin.rearZ + layout.cabin.size.z * 0.26,
      );
      group.add(cargoWindow);
    }
  } else if (build.baseId === 'dustback-rs') {
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.035, layout.cabin.sideWindows[0].size.y, 0.07), mats.trim);
      pillar.name = `rally.bPillar.${side}`;
      pillar.position.set(
        side * (layout.cabin.size.x / 2 + 0.025),
        layout.cabin.sideWindows[0].center.y,
        layout.cabin.frontZ - layout.cabin.size.z * 0.48,
      );
      group.add(pillar);
    }
    addTube(
      group,
      new THREE.Vector3(-ext.x * 0.58, ext.y + 0.04, layout.cabin.frontZ - 0.32),
      new THREE.Vector3(-ext.x * 0.50, layout.cabin.roofY - 0.05, layout.cabin.rearZ + 0.30),
      0.025, mats.chrome, 'rally.rollCage.left',
    );
    addTube(
      group,
      new THREE.Vector3(ext.x * 0.58, ext.y + 0.04, layout.cabin.frontZ - 0.32),
      new THREE.Vector3(ext.x * 0.50, layout.cabin.roofY - 0.05, layout.cabin.rearZ + 0.30),
      0.025, mats.chrome, 'rally.rollCage.right',
    );
  }
}

function addRallyAccessories(
  front: THREE.Group,
  roof: THREE.Group,
  rear: THREE.Group,
  layout: VehicleVisualLayout,
  mats: Materials,
  build: VehicleBuild,
): void {
  const ext = layout.extents;
  if (build.frontBarId.endsWith('.sump-guard')) {
    const guard = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.26, 0.06, 0.58), mats.chrome);
    guard.name = 'rally.sumpGuard';
    guard.position.set(0, -ext.y - 0.015, 0.13);
    guard.rotation.x = -0.16;
    front.add(guard);
  } else if (build.frontBarId.endsWith('.lamp-pod')) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.15, 0.24, 0.12), mats.body);
    pod.name = 'rally.lampPod';
    pod.position.set(0, ext.y * 0.78, 0.04);
    front.add(pod);
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff5d8, emissive: 0xffd47a, emissiveIntensity: 0.8 });
    for (let i = 0; i < 4; i++) {
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.055, 16), lampMat);
      lamp.name = `rally.auxLamp.${i}`;
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set((i - 1.5) * 0.24, ext.y * 0.78, 0.12);
      front.add(lamp);
    }
  }

  if (build.roofId.endsWith('.rally-vent')) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.10, 0.42), mats.body);
    vent.name = 'rally.roofVent';
    vent.position.set(0, 0.07, layout.roofSurface.length * 0.14);
    vent.rotation.x = -0.08;
    roof.add(vent);
  } else if (build.roofId.endsWith('.rally-antenna')) {
    addTube(
      roof,
      new THREE.Vector3(ext.x * 0.42, 0.02, -layout.roofSurface.length * 0.22),
      new THREE.Vector3(ext.x * 0.50, 0.82, -layout.roofSurface.length * 0.34),
      0.012, mats.black, 'rally.antenna',
    );
  }

  if (build.rearBodyId.endsWith('.option-a')) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.58, 0.07, 0.30), mats.body);
    blade.name = 'rally.ducktail';
    blade.position.set(0, layout.cabin.roofY * 0.58, -0.17);
    blade.rotation.x = -0.14;
    rear.add(blade);
  } else if (build.rearBodyId.endsWith('.option-b')) {
    const spare = buildSingleWheel(Physics.geomFor(build).wheelRadius * 0.86, 0.14, build).group;
    spare.name = 'rally.internalSpare';
    spare.rotation.z = Math.PI / 2;
    spare.position.set(-ext.x * 0.22, ext.y * 0.30, 0.27);
    rear.add(spare);
    const tools = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.22, 0.28), mats.black);
    tools.name = 'rally.toolPack';
    tools.position.set(ext.x * 0.42, ext.y * 0.05, 0.24);
    rear.add(tools);
  }
}

function addAccessories(
  group: THREE.Group,
  layout: VehicleVisualLayout,
  mats: Materials,
  build: VehicleBuild,
): void {
  const ext = layout.extents;
  const front = new THREE.Group(); front.name = 'attachment.frontBar'; group.add(front);
  const roof = new THREE.Group(); roof.name = 'attachment.roof'; group.add(roof);
  const rear = new THREE.Group(); rear.name = 'attachment.rearBody'; group.add(rear);
  const intake = new THREE.Group(); intake.name = 'attachment.snorkel'; group.add(intake);
  front.position.set(layout.anchors.frontBar.x, layout.anchors.frontBar.y, layout.anchors.frontBar.z);
  roof.position.set(layout.anchors.roof.x, layout.anchors.roof.y, layout.anchors.roof.z);
  rear.position.set(layout.anchors.rearBody.x, layout.anchors.rearBody.y, layout.anchors.rearBody.z);
  intake.position.set(layout.anchors.snorkel.x, layout.anchors.snorkel.y, layout.anchors.snorkel.z);

  if (layout.style === 'rally') {
    addRallyAccessories(front, roof, rear, layout, mats, build);
    return;
  }

  const metal = build.frontBarId.endsWith('.steel-winch') ? mats.black : mats.chrome;
  if (build.frontBarId.endsWith('.factory')) {
    const factory = new THREE.Mesh(
      new THREE.BoxGeometry(ext.x * 1.82, layout.style === 'utility' ? 0.12 : 0.13, 0.12),
      mats.trim,
    );
    factory.name = 'front.factoryBumper';
    factory.position.set(0, -ext.y * (layout.style === 'utility' ? 0.34 : 0.35), 0.07);
    front.add(factory);
  } else {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 2.08, 0.22, 0.22), metal);
    beam.name = 'front.barBeam';
    beam.position.set(0, -ext.y * 0.12, 0.16);
    front.add(beam);
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(ext.x * 0.64, 0.045, 8, 20, Math.PI), metal);
    hoop.name = 'front.barHoop';
    hoop.rotation.z = Math.PI;
    hoop.position.set(0, ext.y * 0.12, 0.2);
    front.add(hoop);
  }
  if (build.winchId.endsWith('.fitted')) {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.52, 16), mats.chrome);
    drum.name = 'front.winchDrum';
    drum.rotation.z = Math.PI / 2;
    drum.position.set(0, -ext.y * 0.02, 0.31);
    front.add(drum);
    const fairlead = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.08, 0.05), mats.chrome);
    fairlead.name = 'front.winchFairlead';
    fairlead.position.set(0, -ext.y * 0.02, 0.45);
    front.add(fairlead);
  }
  if (build.snorkelId.endsWith('.fitted')) {
    const pipeHeight = layout.snorkel.pipeTopY - layout.snorkel.pipeBottomY;
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, pipeHeight, 12), mats.black);
    pipe.name = 'snorkel.pipe';
    pipe.position.set(0, pipeHeight / 2, 0);
    intake.add(pipe);
    const elbow = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.10, 0.14), mats.black);
    elbow.name = 'snorkel.elbow';
    elbow.position.set(0, 0.05, -0.04);
    intake.add(elbow);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.24), mats.black);
    head.name = 'snorkel.head';
    head.position.set(0, pipeHeight + 0.02, 0.04);
    intake.add(head);
  }
  if (!build.roofId.endsWith('.none')) {
    const rackWidth = layout.roofSurface.width * 0.90;
    const rackLength = layout.roofSurface.length * 0.85;
    for (const [index, x, z] of [
      [0, -rackWidth * 0.40, -rackLength * 0.36],
      [1, rackWidth * 0.40, -rackLength * 0.36],
      [2, -rackWidth * 0.40, rackLength * 0.36],
      [3, rackWidth * 0.40, rackLength * 0.36],
    ] as const) {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.04, 0.09), mats.black);
      foot.name = `roof.foot.${index}`;
      foot.position.set(x, 0.02, z);
      roof.add(foot);
    }
    const platform = new THREE.Mesh(new THREE.BoxGeometry(rackWidth, 0.08, rackLength), mats.black);
    platform.name = 'roof.platform';
    platform.position.set(0, 0.08, 0);
    roof.add(platform);
    if (build.roofId.endsWith('.basket')) {
      for (const [index, x] of [-1, 1].entries()) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, rackLength), mats.black);
        rail.name = `roof.sideRail.${index}`;
        rail.position.set(x * (rackWidth / 2 - 0.025), 0.23, 0);
        roof.add(rail);
      }
      for (const [index, z] of [-1, 1].entries()) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(rackWidth, 0.22, 0.05), mats.black);
        rail.name = `roof.endRail.${index}`;
        rail.position.set(0, 0.23, z * (rackLength / 2 - 0.025));
        roof.add(rail);
      }
    } else {
      const awning = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, rackLength * 0.94, 12), mats.chrome);
      awning.name = 'roof.awning';
      awning.rotation.x = Math.PI / 2;
      awning.position.set(rackWidth / 2 + 0.09, 0.16, 0);
      roof.add(awning);
    }
  }
  if (!build.rearBodyId.endsWith('.factory')) {
    const heavy = build.rearBodyId.endsWith('.option-b');
    if (layout.style === 'utility') {
      const rearBox = heavy
        ? layout.canopy!
        : {
            center: { x: 0, y: ext.y + 0.11, z: layout.tray!.centerZ },
            size: { x: ext.x * 1.88, y: 0.22, z: layout.tray!.length * 0.92 },
          };
      const fitted = new THREE.Mesh(
        new THREE.BoxGeometry(rearBox.size.x, rearBox.size.y, rearBox.size.z),
        heavy ? mats.chrome : mats.black,
      );
      fitted.name = heavy ? 'rear.canopy' : 'rear.tray';
      fitted.position.set(
        rearBox.center.x - layout.anchors.rearBody.x,
        rearBox.center.y - layout.anchors.rearBody.y,
        rearBox.center.z - layout.anchors.rearBody.z,
      );
      rear.add(fitted);
    } else {
      const carrier = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.9, 0.12, 0.12), mats.black);
      carrier.name = 'rear.carrier';
      carrier.position.set(0, ext.y * 0.15, -0.17);
      rear.add(carrier);
      const spareCount = heavy ? 2 : 1;
      for (let i = 0; i < spareCount; i++) {
        const spare = buildSingleWheel(Physics.geomFor(build).wheelRadius * 0.92, 0.20, build).group;
        spare.name = `rear.spare.${i}`;
        spare.rotation.y = Math.PI / 2;
        spare.position.set((i - (spareCount - 1) / 2) * ext.x * 0.88, ext.y * 0.48, -0.25);
        rear.add(spare);
      }
      if (heavy) {
        const ladder = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.05, 0.08), mats.chrome);
        ladder.name = 'rear.ladder';
        ladder.position.set(ext.x * 0.62, ext.y + 0.48, -0.14);
        rear.add(ladder);
      }
    }
  }
}

export function buildCarMesh(value: CarKind | VehicleBuild, _isLocal: boolean, _idHash: number): CarMesh {
  const build = typeof value === 'string'
    ? createStockBuild(normalizeVehicleBaseId(value))
    : normalizeVehicleBuild(value);
  const group = new THREE.Group();
  group.name = `vehicle.${build.baseId}`;
  const layout = createVehicleVisualLayout(build);
  const ext = layout.extents;
  const mats = makeMaterials(Number.parseInt(build.paintColor.slice(1), 16), build.paintFinish);

  if (layout.style === 'crawler') {
    buildCrawlerBody(group, layout, mats);
  } else if (layout.style !== 'rally') {
    buildLowerBodyAndFlares(group, ext, mats, build);
  }
  if (layout.style === 'rally') {
    buildRallyBody(group, layout, mats, build);
  } else if (layout.style === 'utility') {
    buildUtilityBody(group, layout, mats);
  } else if (layout.style === 'wagon') {
    buildWagonBody(group, layout, mats);
  }
  if (layout.style !== 'crawler') addSharedDetail(group, layout, mats, build);
  else {
    group.userData.vehicleBuild = build;
    group.userData.vehicleVisualLayout = layout;
  }
  addBaseCharacter(group, layout, mats, build);
  addAccessories(group, layout, mats, build);
  const { axles, wheels, tires } = buildAxles(group, build, mats.dirt, mats.rubberDetail);
  const suspension = buildSuspensionVisual(group, axles, build);
  const points = Physics.geomFor(build).recoveryPoints;
  const recovery = {
    fairlead: new THREE.Object3D(),
    front: new THREE.Object3D(),
    rear: new THREE.Object3D(),
  };
  for (const key of ['fairlead', 'front', 'rear'] as const) {
    recovery[key].name = `recovery.${key}`;
    recovery[key].position.set(points[key].x, points[key].y, points[key].z);
    group.add(recovery[key]);
  }
  let dirtAmount = 0;
  return {
    group, wheels, tires, axles, suspension, recovery,
    updateDirt(dtSeconds, mudContact, waterContact) {
      // Deep mud coats quickly; ordinary mud builds over several wheel turns.
      dirtAmount += mudContact * dtSeconds * 0.22;
      // Only sustained water contact cleans the truck, rather than a single splash.
      dirtAmount -= waterContact * dtSeconds * 0.16;
      dirtAmount = THREE.MathUtils.clamp(dirtAmount, 0, 1);
      mats.dirt.value += (dirtAmount - mats.dirt.value) * Math.min(1, dtSeconds * 4);
    },
  };
}

/** Hash a player id string to a stable small int for color selection. */
export function colorHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}
