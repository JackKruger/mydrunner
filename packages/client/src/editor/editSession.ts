// The map being edited: the composed world you see, the document you
// save, and the undo stack between them.
//
// The authoritative edit state is the CENTIMETRE delta, not the metre
// heights — the document stores int16 centimetres, so deriving the
// heights from the delta (rather than the other way round on save) means
// what you sculpted is exactly what reloads. Deriving on save instead
// would requantise every cell and shift the terrain by up to 5 mm the
// first time you opened your own file.
//
// Undo snapshots the whole edit state per action rather than tracking
// per-cell diffs. At the shipped 128² that is 48 KB a step, so a 60-step
// history costs under 3 MB — cheap enough that the simpler, obviously
// correct version wins over lazily journalling touched cells.

import { Maps, Physics } from '@mydrunner/shared';
import { forEachBrushCell, type GridSpec } from './brush.js';
import { History } from './history.js';

const { HEIGHT_DELTA_SCALE, NO_SURFACE_OVERRIDE } = Maps;

export type SculptMode = 'raise' | 'lower' | 'smooth' | 'flatten';

interface Snapshot {
  delta: Int16Array;
  override: Uint8Array;
  added: Maps.PlacedObject[];
  removed: string[];
  spawns: Maps.SpawnPoint[];
  includeProcedural: boolean;
}

const MAX_HISTORY = 60;

export class EditSession {
  readonly world: Maps.MapWorld;
  /** Generated ground before any authored edit. Every composed height is
   *  base + delta, recomputed rather than accumulated, so repeated
   *  strokes over one cell cannot drift. */
  private readonly baseHeights: Float32Array;
  private readonly baseSurfaces: Uint8Array;
  private delta: Int16Array;
  private override: Uint8Array;
  private added: Maps.PlacedObject[];
  private removed: string[];
  private spawns: Maps.SpawnPoint[];
  private includeProcedural: boolean;
  private history = new History<Snapshot>({
    capture: () => this.snapshot(),
    restore: (s) => this.restore(s),
  }, MAX_HISTORY);
  private strokeOpen = false;
  private objectSeq = 0;

  private constructor(doc: Maps.MapDoc, world: Maps.MapWorld, base: Physics.TerrainData) {
    this.world = world;
    this.baseHeights = Float32Array.from(base.heights);
    this.baseSurfaces = Uint8Array.from(base.surfaces);
    this.added = doc.objects.added.map((o) => ({ ...o }));
    this.removed = [...doc.objects.removed];
    this.spawns = doc.spawns.map((s) => ({ ...s }));
    this.includeProcedural = doc.objects.includeProcedural;

    const n = doc.base.resolution;
    if (doc.bake) {
      // Opening a baked map un-bakes it into delta form, which is the one
      // representation the tools edit. Lossless to the format's own
      // centimetre quantum, and re-baking on save puts it straight back.
      this.delta = new Int16Array(n * n);
      this.override = new Uint8Array(n * n).fill(NO_SURFACE_OVERRIDE);
      for (let i = 0; i < n * n; i++) {
        this.delta[i] = Math.round((world.terrain.heights[i]! - this.baseHeights[i]!) * HEIGHT_DELTA_SCALE);
        const s = world.terrain.surfaces[i]!;
        if (s !== this.baseSurfaces[i]) this.override[i] = s;
      }
    } else {
      this.delta = Maps.decodeInt16Grid(doc.heightDelta);
      this.override = Maps.decodeUint8Grid(doc.surfaceOverride, NO_SURFACE_OVERRIDE);
    }
    this.recomposeAll();
  }

  /** Open a document. Base drift is ignored rather than fatal: a map
   *  whose ground has moved under it is exactly what the editor exists to
   *  repair, so it must be openable. Saving re-cuts the delta against the
   *  current base, which is the rebase. */
  static open(doc: Maps.MapDoc): EditSession {
    const world = Maps.applyMapDoc(doc, { onBaseDrift: 'ignore' });
    const base = Physics.generateTerrain({
      seed: doc.base.seed,
      size: doc.base.size,
      resolution: doc.base.resolution,
      roads: doc.roads.length ? doc.roads : undefined,
      bogs: doc.bogs,
      pad: doc.pad,
    });
    return new EditSession(doc, world, base);
  }

  get grid(): GridSpec {
    return { size: this.world.terrain.size, resolution: this.world.terrain.resolution };
  }

  get spawnPoints(): readonly Maps.SpawnPoint[] {
    return this.spawns;
  }

  get canUndo(): boolean { return this.history.canUndo; }
  get canRedo(): boolean { return this.history.canRedo; }

  // --- Editing ---------------------------------------------------------

  /** Open an undo group. A drag is one stroke, so dragging the raise
   *  brush across a hillside undoes in one step rather than fifty. */
  beginStroke(): void {
    if (this.strokeOpen) return;
    this.pushUndo();
    this.strokeOpen = true;
  }

  endStroke(): void {
    this.strokeOpen = false;
  }

  /** Sculpt at a world point. Returns the rect that moved, for the mesh
   *  to re-upload; null when the brush missed the grid entirely. */
  sculpt(
    x: number,
    z: number,
    opts: { radius: number; strength: number; hardness: number; mode: SculptMode; dt: number },
  ): Physics.GridRect | null {
    const g = this.grid;
    const heights = this.world.terrain.heights;
    // Flatten needs a target sampled before the stroke edits anything,
    // or the plateau would chase the brush upward as it went.
    const target = opts.mode === 'flatten'
      ? Physics.sampleHeightBilinear(this.world.terrain, x, z)
      : 0;
    const perSecond = opts.strength * opts.dt * HEIGHT_DELTA_SCALE;

    const rect = forEachBrushCell(g, x, z, opts.radius, opts.hardness, ({ index, r, c, weight }) => {
      const cur = this.delta[index]!;
      let next = cur;
      switch (opts.mode) {
        case 'raise': next = cur + perSecond * weight; break;
        case 'lower': next = cur - perSecond * weight; break;
        case 'smooth': {
          const avg = this.neighbourAverage(r, c);
          const curH = heights[index]!;
          next = cur + (avg - curH) * HEIGHT_DELTA_SCALE * weight * Math.min(1, opts.dt * 8);
          break;
        }
        case 'flatten': {
          const curH = heights[index]!;
          next = cur + (target - curH) * HEIGHT_DELTA_SCALE * weight * Math.min(1, opts.dt * 8);
          break;
        }
      }
      this.delta[index] = clampInt16(Math.round(next));
      heights[index] = this.baseHeights[index]! + this.delta[index]! / HEIGHT_DELTA_SCALE;
    });
    return rect.rows > 0 ? rect : null;
  }

  paint(x: number, z: number, opts: { radius: number; surface: Physics.Surface }): Physics.GridRect | null {
    const surfaces = this.world.terrain.surfaces;
    // Hardness 1: a surface id cannot be blended, so a soft edge would
    // just mean a ragged rim of half-painted cells.
    const rect = forEachBrushCell(this.grid, x, z, opts.radius, 1, ({ index }) => {
      this.override[index] = opts.surface;
      surfaces[index] = opts.surface;
    });
    return rect.rows > 0 ? rect : null;
  }

  /** Place an object. Y is resolved from the live ground at save/compose
   *  time, so only x/z are stored here. */
  addObject(o: Omit<Maps.PlacedObject, 'id'>): Maps.PlacedObject {
    this.pushUndo();
    const placed: Maps.PlacedObject = { ...o, id: `a${this.objectSeq++}-${Date.now().toString(36)}` };
    this.added.push(placed);
    this.rebuildObjects();
    return placed;
  }

  /** Delete by id. Authored objects are dropped outright; generated ones
   *  go on the removed list, which is what survives regeneration. */
  deleteObject(id: string): void {
    this.pushUndo();
    const i = this.added.findIndex((o) => o.id === id);
    if (i >= 0) this.added.splice(i, 1);
    else if (!this.removed.includes(id)) this.removed.push(id);
    this.rebuildObjects();
  }

  addSpawn(s: Maps.SpawnPoint): void {
    this.pushUndo();
    this.spawns.push({ ...s });
  }

  /** Remove the spawn nearest (x, z) within `within` metres. Returns
   *  whether one was found. */
  deleteSpawnNear(x: number, z: number, within: number): boolean {
    let best = -1;
    let bestD = within;
    this.spawns.forEach((s, i) => {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d <= bestD) { bestD = d; best = i; }
    });
    if (best < 0) return false;
    this.pushUndo();
    this.spawns.splice(best, 1);
    return true;
  }

  /** Re-seat objects on the ground as it is now, and rebuild the list.
   *  Called when a height stroke ends: a rock that was sitting on a hill
   *  you just lowered is otherwise left hanging in the air. */
  rebuildObjects(): void {
    this.world.obstacles = Physics.generateObstacles(this.world.terrain, {
      includeProcedural: this.includeProcedural,
      removed: this.removed,
      added: this.added.map((p) => resolvePlaced(p, this.world.terrain)),
    });
    this.world.landmarks = Physics.landmarksFor(this.world.terrain);
  }

  // --- Undo ------------------------------------------------------------

  private pushUndo(): void {
    this.history.push();
  }

  undo(): boolean { return this.history.undo(); }
  redo(): boolean { return this.history.redo(); }

  private snapshot(): Snapshot {
    return {
      delta: Int16Array.from(this.delta),
      override: Uint8Array.from(this.override),
      added: this.added.map((o) => ({ ...o })),
      removed: [...this.removed],
      spawns: this.spawns.map((s) => ({ ...s })),
      includeProcedural: this.includeProcedural,
    };
  }

  private restore(s: Snapshot): void {
    this.delta = Int16Array.from(s.delta);
    this.override = Uint8Array.from(s.override);
    this.added = s.added.map((o) => ({ ...o }));
    this.removed = [...s.removed];
    this.spawns = s.spawns.map((x) => ({ ...x }));
    this.includeProcedural = s.includeProcedural;
    this.recomposeAll();
    this.rebuildObjects();
  }

  /** Rebuild every composed cell from base + edits. */
  private recomposeAll(): void {
    const t = this.world.terrain;
    for (let i = 0; i < t.heights.length; i++) {
      t.heights[i] = this.baseHeights[i]! + this.delta[i]! / HEIGHT_DELTA_SCALE;
      const o = this.override[i]!;
      t.surfaces[i] = o === NO_SURFACE_OVERRIDE ? this.baseSurfaces[i]! : o;
    }
  }

  private neighbourAverage(r: number, c: number): number {
    const n = this.world.terrain.resolution;
    const h = this.world.terrain.heights;
    let sum = 0;
    let count = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
        sum += h[rr * n + cc]!;
        count++;
      }
    }
    return count > 0 ? sum / count : h[r * n + c]!;
  }

  // --- Saving ----------------------------------------------------------

  /** The document as it stands.
   *
   *  baseChecksum is re-stamped from the base this session composed
   *  against, so saving an opened-with-drift map rebases it: the delta
   *  now means what it looks like on screen rather than what it meant
   *  against ground the generator has since moved. */
  toDoc(prev: Maps.MapDoc, opts: { bake?: boolean } = {}): Maps.MapDoc {
    const n = this.world.terrain.resolution;
    const doc: Maps.MapDoc = {
      ...prev,
      formatVersion: Maps.MAP_FORMAT_VERSION,
      baseChecksum: Maps.baseChecksumOf({
        ...this.world.terrain,
        heights: this.baseHeights,
        surfaces: this.baseSurfaces,
      }),
      heightDelta: Maps.encodeInt16Grid(this.delta, n),
      surfaceOverride: Maps.encodeUint8Grid(this.override, n, NO_SURFACE_OVERRIDE),
      objects: {
        includeProcedural: this.includeProcedural,
        added: this.added.map((o) => ({ ...o })),
        removed: [...this.removed],
      },
      spawns: this.spawns.map((s) => ({ ...s })),
    };
    if (opts.bake) {
      const cm = new Int16Array(n * n);
      for (let i = 0; i < n * n; i++) {
        cm[i] = clampInt16(Math.round(this.world.terrain.heights[i]! * HEIGHT_DELTA_SCALE));
      }
      doc.bake = {
        heights: Maps.encodeInt16Grid(cm, n),
        surfaces: Maps.encodeUint8Grid(Uint8Array.from(this.world.terrain.surfaces), n, 0),
      };
    } else {
      delete doc.bake;
    }
    return doc;
  }
}

/** Seat an authored object on the ground, matching applyMapDoc's rule so
 *  the editor's preview and the loaded map agree. */
function resolvePlaced(p: Maps.PlacedObject, t: Physics.TerrainData): Physics.Obstacle {
  return {
    id: p.id,
    kind: p.kind,
    x: p.x,
    y: Physics.sampleHeightBilinear(t, p.x, p.z) + (p.yOffset ?? 0),
    z: p.z,
    size: p.size,
    height: p.height,
    yaw: p.yaw,
    ...(p.length === undefined ? {} : { length: p.length }),
  };
}

/** The delta grid is int16 centimetres: ±327 m against a 70 m peak. A
 *  brush held down at the edge would otherwise wrap and punch a hole
 *  through the map. */
function clampInt16(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}
