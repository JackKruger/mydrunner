// Player nameplate - a Three.js Sprite with text rendered to a canvas
// texture. Sprites always face the camera so the label is readable from
// any angle. One sprite per vehicle, attached as a child of the chassis
// group so it follows automatically.

import * as THREE from 'three';

const FONT = '500 56px ui-sans-serif, system-ui, sans-serif';

function makeTextTexture(text: string): { texture: THREE.Texture; aspect: number } {
  // Measure first so we can size the canvas tightly.
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d')!;
  measureCtx.font = FONT;
  const metrics = measureCtx.measureText(text);
  const padX = 24;
  const padY = 16;
  const width = Math.ceil(metrics.width + padX * 2);
  const height = 96;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  // Rounded rect background.
  const r = 14;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(width - r, 0);
  ctx.quadraticCurveTo(width, 0, width, r);
  ctx.lineTo(width, height - r);
  ctx.quadraticCurveTo(width, height, width - r, height);
  ctx.lineTo(r, height);
  ctx.quadraticCurveTo(0, height, 0, height - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.fill();

  ctx.font = FONT;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return { texture, aspect: width / height };
}

export function createNameplate(name: string): THREE.Sprite {
  const { texture, aspect } = makeTextTexture(name);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  // Visual size in world units. Width follows aspect.
  const heightWorld = 0.6;
  sprite.scale.set(heightWorld * aspect, heightWorld, 1);
  return sprite;
}

export function disposeNameplate(sprite: THREE.Sprite): void {
  const m = sprite.material;
  m.map?.dispose();
  m.dispose();
}
