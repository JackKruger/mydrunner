// One source of truth for the outdoor render transform and the lighting
// values mirrored by the raw terrain and water shaders.

import * as THREE from 'three';

export type RenderTuningKey =
  | 'exposure'
  | 'sunIntensity'
  | 'hemisphereIntensity'
  | 'shaderAmbientIntensity'
  | 'grassBrightness'
  | 'terrainMacroTint'
  | 'terrainTriplanarStrength'
  | 'terrainNormalStrength'
  | 'terrainShading'
  | 'fogAmount';

export interface RenderTuningTarget {
  getRenderTuning(key: RenderTuningKey): number;
  setRenderTuning(key: RenderTuningKey, value: number): void;
}

interface RenderEnvironment {
  outputColorSpace: THREE.ColorSpace;
  toneMapping: THREE.ToneMapping;
  exposure: number;
  fog: { color: number; near: number; far: number; amount: number };
  sun: { color: number; intensity: number; position: { x: number; y: number; z: number } };
  hemisphere: { skyColor: number; groundColor: number; intensity: number };
  shaderAmbientIntensity: number;
  grassBrightness: number;
  terrainMacroTint: number;
  terrainTriplanarStrength: number;
  terrainNormalStrength: number;
  terrainShading: number;
}

/** Mutable only through WorldView's RenderTuningTarget implementation. */
export const RENDER_ENVIRONMENT: RenderEnvironment = {
  outputColorSpace: THREE.SRGBColorSpace,
  toneMapping: THREE.NeutralToneMapping,
  exposure: 1.25,
  fog: { color: 0xd6e2ec, near: 180, far: 480, amount: 1 },
  sun: { color: 0xfff1d2, intensity: 2.05, position: { x: 50, y: 80, z: 30 } },
  hemisphere: { skyColor: 0xb8d0e2, groundColor: 0x66553c, intensity: 0.75 },
  shaderAmbientIntensity: 0.95,
  grassBrightness: 0.63,
  terrainMacroTint: 0.53,
  terrainTriplanarStrength: 0.47,
  terrainNormalStrength: 0.21,
  terrainShading: 0.83,
};

/** Move fog onset toward its far plane as the dev amount approaches zero. */
export function effectiveFogNear(): number {
  const fog = RENDER_ENVIRONMENT.fog;
  return THREE.MathUtils.lerp(fog.far - 0.01, fog.near, fog.amount);
}

/**
 * Build a tiny deterministic outdoor panorama and prefilter it for PBR.
 * Keeping this generated avoids a large HDR download while scene.environment
 * still gives every standard/physical material the same image-based light.
 */
export function createOutdoorEnvironment(renderer: THREE.WebGLRenderer): {
  texture: THREE.Texture;
  dispose(): void;
} {
  const width = 64;
  const height = 32;
  const pixels = new Uint8Array(width * height * 4);
  const sky = new THREE.Color(0x7fa9c7);
  const horizon = new THREE.Color(RENDER_ENVIRONMENT.fog.color);
  const ground = new THREE.Color(0x665b43);
  const sunDirection = new THREE.Vector3(
    RENDER_ENVIRONMENT.sun.position.x,
    RENDER_ENVIRONMENT.sun.position.y,
    RENDER_ENVIRONMENT.sun.position.z,
  ).normalize();
  const sampleDirection = new THREE.Vector3();
  const color = new THREE.Color();

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const phi = v * Math.PI;
    for (let x = 0; x < width; x++) {
      const theta = ((x + 0.5) / width) * Math.PI * 2 - Math.PI;
      sampleDirection.set(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta));
      if (sampleDirection.y >= 0) color.copy(horizon).lerp(sky, Math.pow(sampleDirection.y, 0.55));
      else color.copy(horizon).lerp(ground, Math.min(1, -sampleDirection.y * 1.8));
      const sun = Math.pow(Math.max(0, sampleDirection.dot(sunDirection)), 700);
      color.lerp(new THREE.Color(0xfff2c2), sun * 0.9).convertLinearToSRGB();
      const i = (y * width + x) * 4;
      pixels[i] = Math.round(color.r * 255);
      pixels[i + 1] = Math.round(color.g * 255);
      pixels[i + 2] = Math.round(color.b * 255);
      pixels[i + 3] = 255;
    }
  }

  const panorama = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  panorama.colorSpace = THREE.SRGBColorSpace;
  panorama.mapping = THREE.EquirectangularReflectionMapping;
  panorama.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromEquirectangular(panorama);
  panorama.dispose();
  pmrem.dispose();
  return { texture: target.texture, dispose: () => target.dispose() };
}
