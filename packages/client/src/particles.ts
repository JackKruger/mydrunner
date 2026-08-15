// Pooled and batched vehicle particles. Emission policy deliberately stays in
// VehicleEffects; this file only chooses the cheapest renderer for each effect.
import * as THREE from 'three';
import { activeQuality, type QualitySettings } from './quality.js';

const GRAVITY = -9.81;
export type ParticleEffect = 'dust' | 'smoke' | 'water' | 'mud' | 'gravel' | 'grass';

interface Particle {
  pos: THREE.Vector3; vel: THREE.Vector3; ageMs: number; lifeMs: number;
  active: boolean; scale: number; gravity: number; endScale: number;
  opacity: number; color: THREE.Color; rotation: number; contactY?: number;
}

export interface EmitOptions {
  effect?: ParticleEffect;
  spread?: number; rise?: number; riseVar?: number; biasX?: number; biasZ?: number;
  lifeMs?: number; lifeVarMs?: number; scale?: number; gravity?: number;
  endScale?: number; opacity?: number;
  /** Water height at which a falling spray drop turns into a foam decal. */
  contactY?: number;
}

interface PoolRenderer {
  readonly object: THREE.Object3D;
  emit(p: Particle): void;
  update(dtMs: number): void;
  dispose(): void;
  activeCount(): number;
}

abstract class PoolBase implements PoolRenderer {
  abstract readonly object: THREE.Object3D;
  protected readonly pool: Particle[];
  protected cursor = 0;
  constructor(protected readonly capacity: number, protected readonly onWaterContact?: (p: Particle) => void) {
    this.pool = Array.from({ length: capacity }, () => ({
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), ageMs: 0, lifeMs: 0,
      active: false, scale: 1, gravity: GRAVITY, endScale: 0, opacity: 1,
      color: new THREE.Color(), rotation: 0,
    }));
  }
  emit(source: Particle): void {
    const p = this.pool[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.capacity;
    p.pos.copy(source.pos); p.vel.copy(source.vel); p.color.copy(source.color);
    p.ageMs = 0; p.lifeMs = source.lifeMs; p.active = true; p.scale = source.scale;
    p.gravity = source.gravity; p.endScale = source.endScale; p.opacity = source.opacity;
    p.rotation = source.rotation; p.contactY = source.contactY;
  }
  update(dtMs: number): void {
    const dt = dtMs / 1000;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.ageMs += dtMs;
      if (p.ageMs >= p.lifeMs) { p.active = false; continue; }
      p.vel.y += p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      if (p.contactY !== undefined && p.vel.y < 0 && p.pos.y <= p.contactY) {
        p.pos.y = p.contactY; p.active = false; this.onWaterContact?.(p);
      }
    }
    this.flush();
  }
  activeCount(): number { return this.pool.reduce((n, p) => n + Number(p.active), 0); }
  protected abstract flush(): void;
  abstract dispose(): void;
}

/** Camera-facing animated atlas sprites. One Points draw call covers a pool. */
class AtlasRenderer extends PoolBase {
  readonly object: THREE.Points;
  private readonly geo: THREE.BufferGeometry;
  private readonly positions: Float32Array; private readonly colors: Float32Array;
  private readonly sizes: Float32Array; private readonly frames: Float32Array;
  private readonly mat: THREE.ShaderMaterial;
  private readonly atlas: THREE.DataTexture;
  constructor(capacity: number, q: QualitySettings, atlasFrames: number) {
    super(capacity);
    this.positions = new Float32Array(capacity * 3); this.colors = new Float32Array(capacity * 4);
    this.sizes = new Float32Array(capacity); this.frames = new Float32Array(capacity);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('particleColor', new THREE.BufferAttribute(this.colors, 4));
    this.geo.setAttribute('particleSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geo.setAttribute('atlasFrame', new THREE.BufferAttribute(this.frames, 1));
    const side = Math.round(Math.sqrt(atlasFrames)), cell = 16, pixels = new Uint8Array(side * cell * side * cell * 4);
    for (let y=0;y<side*cell;y++) for(let x=0;x<side*cell;x++){const frame=Math.floor(x/cell)+Math.floor(y/cell)*side,dx=(x%cell+.5)/cell-.5,dy=(y%cell+.5)/cell-.5,wobble=1+.12*Math.sin(frame*2.17),alpha=Math.max(0,1-Math.hypot(dx*wobble,dy/wobble)*2),i=(x+y*side*cell)*4;pixels[i]=pixels[i+1]=pixels[i+2]=255;pixels[i+3]=Math.round(alpha*alpha*255);}
    this.atlas=new THREE.DataTexture(pixels,side*cell,side*cell,THREE.RGBAFormat);this.atlas.needsUpdate=true;
    this.mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, vertexColors: true,
      uniforms: { drawDistance: { value: q.effectDrawDistance }, frames: { value: atlasFrames }, atlas: { value: this.atlas } },
      vertexShader: `attribute vec4 particleColor; attribute float particleSize,atlasFrame; varying vec4 vColor; varying float vFrame; uniform float drawDistance; void main(){vec4 mv=modelViewMatrix*vec4(position,1.); float fade=1.-smoothstep(drawDistance*.8,drawDistance,-mv.z); vColor=vec4(particleColor.rgb,particleColor.a*fade); vFrame=atlasFrame; gl_PointSize=particleSize*(260./max(1.,-mv.z)); gl_Position=projectionMatrix*mv;}`,
      fragmentShader: `uniform float frames; uniform sampler2D atlas; varying vec4 vColor; varying float vFrame; void main(){float side=sqrt(frames);vec2 cell=vec2(mod(vFrame,side),floor(vFrame/side));vec2 uv=(gl_PointCoord+cell)/side;float shape=texture2D(atlas,uv).a;${q.softParticles ? ' float softFade=1.-smoothstep(.985,1.,gl_FragCoord.z);' : ' float softFade=1.;'}if(shape<.01)discard;gl_FragColor=vec4(vColor.rgb,vColor.a*shape*softFade);}`,
    });
    this.object = new THREE.Points(this.geo, this.mat); this.object.frustumCulled = false;
  }
  protected flush(): void {
    for (let i=0;i<this.capacity;i++) { const p=this.pool[i]!, o=i*3, c=i*4; this.positions[o]=p.pos.x;this.positions[o+1]=p.pos.y;this.positions[o+2]=p.pos.z; const a=p.active?1-p.ageMs/p.lifeMs:0; this.colors[c]=p.color.r;this.colors[c+1]=p.color.g;this.colors[c+2]=p.color.b;this.colors[c+3]=p.opacity*a;this.sizes[i]=p.scale*(p.endScale+a*(1.2-p.endScale));this.frames[i]=Math.min(this.mat.uniforms.frames!.value-1,Math.floor((1-a)*this.mat.uniforms.frames!.value)); }
    for (const a of Object.values(this.geo.attributes)) a.needsUpdate=true;
  }
  dispose(): void { this.geo.dispose(); this.mat.dispose(); this.atlas.dispose(); }
}

/** Solid mud, gravel and grass fragments; varied rotation is stored in matrices. */
class SolidRenderer extends PoolBase {
  readonly object: THREE.InstancedMesh; private readonly geo: THREE.IcosahedronGeometry;
  private readonly mat: THREE.MeshBasicMaterial; private readonly matrix=new THREE.Matrix4();
  private readonly quat=new THREE.Quaternion(); private readonly axis=new THREE.Vector3(); private readonly scale=new THREE.Vector3();
  constructor(capacity:number){ super(capacity); this.geo=new THREE.IcosahedronGeometry(.07,0);this.mat=new THREE.MeshBasicMaterial();this.object=new THREE.InstancedMesh(this.geo,this.mat,capacity);this.object.frustumCulled=false;this.flush(); }
  override emit(p:Particle):void { const index=this.cursor;super.emit(p);this.object.setColorAt(index,p.color); }
  protected flush():void { for(let i=0;i<this.capacity;i++){const p=this.pool[i]!;const a=p.active?1-p.ageMs/p.lifeMs:0;const s=p.active?p.scale*(p.endScale+a*(1.2-p.endScale)):0;this.axis.set(Math.sin(p.rotation),1,Math.cos(p.rotation)).normalize();this.quat.setFromAxisAngle(this.axis,p.rotation+p.ageMs*.004);this.scale.set(s,s*(.6+.4*Math.abs(Math.sin(p.rotation))),s);this.matrix.compose(p.pos,this.quat,this.scale);this.object.setMatrixAt(i,this.matrix);}this.object.instanceMatrix.needsUpdate=true;if(this.object.instanceColor)this.object.instanceColor.needsUpdate=true; }
  dispose():void { this.geo.dispose();this.mat.dispose();this.object.dispose(); }
}

/** Velocity-aligned water sheets. Droplets share the same renderer/pool. */
class StreakRenderer extends PoolBase {
  readonly object:THREE.InstancedMesh;private geo=new THREE.PlaneGeometry(.08,1);private mat=new THREE.MeshBasicMaterial({transparent:true,opacity:.7,side:THREE.DoubleSide,depthWrite:false});private matrix=new THREE.Matrix4();private quat=new THREE.Quaternion();private scale=new THREE.Vector3();
  constructor(capacity:number,onContact:(p:Particle)=>void){super(capacity,onContact);this.object=new THREE.InstancedMesh(this.geo,this.mat,capacity);this.object.frustumCulled=false;this.flush();}
  protected flush():void{for(let i=0;i<this.capacity;i++){const p=this.pool[i]!,s=p.active?p.scale*(1-p.ageMs/p.lifeMs):0;this.quat.setFromUnitVectors(new THREE.Vector3(0,1,0),p.vel.clone().normalize());this.scale.set(s,s*(.5+Math.min(3,p.vel.length())*.35),s);this.matrix.compose(p.pos,this.quat,this.scale);this.object.setMatrixAt(i,this.matrix);}this.object.instanceMatrix.needsUpdate=true;}
  dispose():void{this.geo.dispose();this.mat.dispose();this.object.dispose();}
}

/** Horizontal foam rings left exactly on the sampled water plane. */
class DecalRenderer extends PoolBase {
  readonly object:THREE.InstancedMesh;private geo=new THREE.PlaneGeometry(1,1);private mat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.);}',fragmentShader:'varying vec2 vUv;void main(){float d=length(vUv-.5);float ring=smoothstep(.48,.39,d)*smoothstep(.22,.31,d);if(ring<.01)discard;gl_FragColor=vec4(.88,.96,1.,ring*.55);}'});private matrix=new THREE.Matrix4();private quat=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),-Math.PI/2);private scale=new THREE.Vector3();
  constructor(capacity:number){super(capacity);this.object=new THREE.InstancedMesh(this.geo,this.mat,capacity);this.object.frustumCulled=false;this.flush();}
  protected flush():void{for(let i=0;i<this.capacity;i++){const p=this.pool[i]!,a=p.active?1-p.ageMs/p.lifeMs:0,s=p.active?p.scale*(.7+(1-a)*1.5):0;this.scale.set(s,s,s);this.matrix.compose(p.pos,this.quat,this.scale);this.object.setMatrixAt(i,this.matrix);}this.object.instanceMatrix.needsUpdate=true;}
  dispose():void{this.geo.dispose();this.mat.dispose();this.object.dispose();}
}

export class ParticleSystem {
  readonly group=new THREE.Group(); private readonly renderers:Record<'atlas'|'solid'|'water'|'decal',PoolRenderer>;
  private seed=0x6d2b79f5; private emitted=0; private readonly density:number;
  constructor(q:QualitySettings=activeQuality()){
    this.density=q.particleDensity;
    const cap=Math.max(1,Math.round(q.maxParticles*q.particleDensity));
    const decal=new DecalRenderer(Math.max(8,Math.floor(cap/4)));
    this.renderers={ atlas:new AtlasRenderer(cap,q,q.particleAtlasFrames), solid:new SolidRenderer(cap), water:new StreakRenderer(Math.max(8,Math.floor(cap/2)),p=>this.emitDecal(p)), decal };
    for(const r of Object.values(this.renderers))this.group.add(r.object);
  }
  private random():number { this.seed=(this.seed+0x6d2b79f5)|0;let t=this.seed;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296; }
  emit(x:number,y:number,z:number,color=0x3a2618,opts:EmitOptions={}):void{
    // Stable thinning: it depends on emission order, never render-frame dt.
    if(this.density<1&&this.random()>this.density)return;
    const spread=opts.spread??3,rise=opts.rise??2,riseVar=opts.riseVar??3;
    const p:Particle={pos:new THREE.Vector3(x,y,z),vel:new THREE.Vector3((this.random()-.5)*spread+(opts.biasX??0),rise+this.random()*riseVar,(this.random()-.5)*spread+(opts.biasZ??0)),ageMs:0,lifeMs:(opts.lifeMs??600)+this.random()*(opts.lifeVarMs??400),active:true,scale:opts.scale??1,gravity:opts.gravity??GRAVITY,endScale:opts.endScale??.6,opacity:opts.opacity??1,color:new THREE.Color(color),rotation:this.random()*Math.PI*2,contactY:opts.contactY};
    const effect=opts.effect??'mud'; const key=effect==='water'?'water':effect==='mud'||effect==='gravel'||effect==='grass'?'solid':'atlas';this.renderers[key].emit(p);this.emitted++;
  }
  private emitDecal(p:Particle):void{const d={...p,pos:p.pos.clone(),vel:new THREE.Vector3(),ageMs:0,lifeMs:900,active:true,scale:p.scale*2,gravity:0,endScale:2.2,opacity:.55,color:new THREE.Color(0xf0f6f8),rotation:0,contactY:undefined};this.renderers.decal.emit(d);}
  update(dtMs:number):void{for(const r of Object.values(this.renderers))r.update(dtMs);}
  /** Introspection used by tests and the renderer debug overlay. */
  stats():{active:number;emitted:number;drawCalls:number}{return{active:Object.values(this.renderers).reduce((n,r)=>n+r.activeCount(),0),emitted:this.emitted,drawCalls:this.group.children.length};}
  dispose():void{for(const r of Object.values(this.renderers))r.dispose();this.group.clear();}
}
