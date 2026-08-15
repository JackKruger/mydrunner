import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import type { QualitySettings } from './quality.js';

/** Named by caller so every camera-owning surface makes an explicit choice.
 * HUD is intentionally absent: it is DOM layered over the renderer canvas,
 * and can therefore never be blurred, graded, or darkened by this pipeline. */
export type RenderPath = 'gameplay' | 'menu-panorama' | 'editor';

export function shouldUsePostProcessAntialias(quality: QualitySettings): boolean {
  return quality.postProcessAntialias && !quality.antialias;
}

const COLOR_GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    saturation: { value: 1 },
    contrast: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float saturation;
    uniform float contrast;
    varying vec2 vUv;
    void main() {
      vec4 source = texture2D(tDiffuse, vUv);
      float luminance = dot(source.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 graded = mix(vec3(luminance), source.rgb, saturation);
      // A tiny contrast lift around middle grey. No black-level offset: AO
      // must add depth without crushing already shaded forest pixels.
      graded = (graded - 0.5) * contrast + 0.5;
      gl_FragColor = vec4(max(graded, vec3(0.0)), source.a);
    }
  `,
};

export class PostProcessing {
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly fxaa: ShaderPass | null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    quality: QualitySettings,
  ) {
    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    if (quality.ambientOcclusion) {
      const ssao = new SSAOPass(scene, camera, 1, 1);
      ssao.kernelRadius = quality.ambientOcclusionRadius;
      ssao.minDistance = 0.002;
      // A short range prevents silhouettes (especially terrain against sky)
      // from acquiring halos while retaining contact depth on nearby forms.
      ssao.maxDistance = 0.055;
      ssao.output = SSAOPass.OUTPUT.Default;
      ssao.kernelRadius *= quality.ambientOcclusionIntensity;
      this.composer.addPass(ssao);
    }

    if (quality.colorGrading) {
      const grade = new ShaderPass(COLOR_GRADE_SHADER);
      grade.uniforms.saturation.value = quality.colorSaturation;
      grade.uniforms.contrast.value = quality.colorContrast;
      this.composer.addPass(grade);
    }

    if (quality.bloom) {
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(1, 1),
        quality.bloomStrength,
        quality.bloomRadius,
        quality.bloomThreshold,
      );
      this.composer.addPass(bloom);
    }

    // WebGL MSAA and a full-screen AA pass solve the same edge problem. FXAA
    // is only worthwhile for a configuration whose context lacks MSAA.
    if (shouldUsePostProcessAntialias(quality)) {
      this.fxaa = new ShaderPass(FXAAShader);
      this.composer.addPass(this.fxaa);
    } else {
      this.fxaa = null;
    }
    this.composer.addPass(new OutputPass());
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    if (this.fxaa) {
      const ratio = this.renderer.getPixelRatio();
      this.fxaa.material.uniforms.resolution.value.set(1 / (width * ratio), 1 / (height * ratio));
    }
  }

  render(camera: THREE.Camera, _path: RenderPath): void {
    this.renderPass.camera = camera;
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
  }
}
