import { markMaterialUboDirty, setMeshAttribute, setThinInstances, type DirectionalLight, type EngineContext as Engine, type MaterialPlugin, type Mesh } from "@babylonjs/lite";
import type { EngineContext } from "../Canvas";
import type { Casters } from "../DayNightCycle";
import { drop, meshOf, show } from "../geometry";
import { grain } from "../ground";
import { townMaterial, type TownMaterial } from "../material";
import type { Rgb } from "../rgb";
import type { Theme } from "../theme";
import { simNow } from "../../network/clock";
import type { GridCoord } from "../../generated/GridCoord";
import type { Job } from "../../generated/Job";
import type { Run } from "../../generated/Run";
import type { Tile } from "../../generated/Tile";

/**
 * A farm's field, as it is seen from the air: every tile of its land
 * covered, worked as a farmer works one. Round the edge the headland, a
 * tile wide, its lines running parallel to whatever the field ends at and
 * turning round each outside corner on an arc, as a tractor going round does;
 * inside, the lands in straight lines along the grain the tractor drove,
 * stopping at the headland where it turned. The lines are a tractor's
 * passes: furrows turned up in ridges, a tile across four of them, that
 * take a low sun; a drill's rows, the crop coming up along them and
 * closing over them, green, then gold, its wheel tracks left open; the
 * stubble after the combine, its straw spread down the middle of each
 * pass. Each stage one clean colour, as the town's are: its texture is
 * all light. Across the passes the field has a height (`fieldHeight`):
 * the ridges and rows tilt its facing and cast their shade into the
 * furrows and tramlines beside them, as a low sun shows a field from the
 * air. Painted in a shader over one quad a tile, so it has no edges of
 * its own to show.
 *
 * A standing crop stands: the field is lifted by its height, so it throws
 * a shadow onto the grass beside it and onto the stubble behind the
 * harvest. The edge is ragged, a margin of grass between field and hedge.
 *
 * On a run (`running`) the tractor's job is painted behind it, tile by
 * tile as it works them and across each as it crosses it, over the stage
 * the field was at; each tile worked once, as the server works it: the
 * lands on the first pass over them, the headland on its own pass round,
 * after the lands when ploughing, before them otherwise (`fields.rs`).
 */

/** What a field shows: a stage of the cycle, and how far grown. */
export type Look = { stage: "Grass" | "Ploughed" | "Sown" | "Cut"; growth: number };

/** The field lies a little over the land, the crop up to this high. */
export const FIELD_Z = 0.008;
const CROP_H = 0.08;
/** How long a sown crop takes to ripen, as the server has it. */
export const RIPEN = 600_000;

/** The runs out now, by farm: the tractor's (`CarObject`), for its
 *  farm's field to paint. */
export const running = new Map<number, Run>();

/** What the field shows between runs: the stage the last run left it in,
 *  which is the stage of the tiles longest unchanged; a sown field grows
 *  as one, from the last tile sown, ripe when the server counts it ripe. */
export function lookOf(land: Tile[]): Look {
  const oldest = land.reduce<Tile | null>((a, t) => (a === null || t.since < a.since ? t : a), null);
  const stage = oldest?.stage ?? "Grass";
  if (stage !== "Sown") return { stage, growth: 0 };
  const since = Math.max(...land.filter((t) => t.stage === "Sown").map((t) => t.since));
  return { stage, growth: Math.min(1, Math.max(0, (simNow() - since) / RIPEN)) };
}

/** What a job leaves behind the tractor. */
const leaves = (job: Job, before: Look): Look =>
  job === "Plough" ? { stage: "Ploughed", growth: 0 } : job === "Seed" ? { stage: "Sown", growth: 0 } : job === "Harvest" ? { stage: "Cut", growth: 0 } : before;

const STAGES = ["Grass", "Ploughed", "Sown", "Cut"];
const heightOf = (l: Look) => (l.stage === "Sown" ? CROP_H * Math.min(1, Math.max(0, (l.growth - 0.1) / 0.6)) : 0);

/** The eight ways off a tile, as the shader reads its mask: the sides,
 *  then the corners. */
const AROUND = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class Field {
  private mesh: Mesh;
  private material: TownMaterial;
  private tiles: GridCoord[];
  private key = new Map<string, number>();
  /** The uniforms: the look before a run and after it, how far the run
   *  has got, and the season's colours. */
  private state = { before: [0, 0, 0, 0], after: [0, 0, 0, 0], progress: 1e9 };
  private colours: Rgb[];
  private data: Float32Array;
  private run: Run | null = null;
  /** Each tile's height, as last laid. */
  private heights: number[];
  private stop: () => void;

  constructor(private ctx: EngineContext, private casters: Casters, private farm: number, land: Tile[], ruts: GridCoord[], theme: Theme) {
    this.tiles = land.map((t) => t.at);
    this.tiles.forEach((t, i) => this.key.set(`${t.x},${t.y}`, i));
    this.colours = [theme.earth, theme.growing, theme.ripe, theme.stubble];
    this.heights = this.tiles.map(() => -1);
    this.data = new Float32Array(this.tiles.length * 8);
    // A tile's mask, of the eight ways which are not field; and the way
    // across the lands, the grain the lands were driven along, which
    // the most steps from one land tile to the next went.
    const has = (x: number, y: number) => this.key.has(`${x},${y}`);
    const masks = this.tiles.map((t) => AROUND.reduce((m, [dx, dy], b) => (has(t.x + dx, t.y + dy) ? m : m | (1 << b)), 0));
    const inside = (t: GridCoord) => { const i = this.key.get(`${t.x},${t.y}`); return i !== undefined && masks[i] === 0; };
    let alongX = 0;
    for (let i = 1; i < ruts.length; i++) {
      const [a, b] = [ruts[i - 1], ruts[i]];
      if (inside(a) && inside(b)) alongX += Math.abs(b.x - a.x) - Math.abs(b.y - a.y);
    }
    this.tiles.forEach((_, i) => {
      this.data.set([masks[i], 0, 0, 0, alongX >= 0 ? 0 : 1, alongX >= 0 ? 1 : 0, 0, 0], i * 8);
    });

    this.material = townMaterial([this.plugin(ctx.engine)], 0.95);
    this.mesh = meshOf(ctx.engine, `field_${farm}`, { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 2, 1, 0, 3, 2] });
    this.mesh.material = this.material;
    this.mesh.receiveShadows = true;
    this.lay(lookOf(land));
    setMeshAttribute(ctx.engine, this.mesh, "field", this.data);
    show(ctx.scene, this.mesh);
    casters.add(this.mesh);

    // Each frame: a run begun or ended, how far it has got; and while the
    // crop grows, how far, now and then.
    let shown = lookOf(land);
    let looked = performance.now();
    this.stop = ctx.beforeRender(() => {
      const run = running.get(farm) ?? null;
      if (run !== this.run) this.follow(run, shown);
      if (run) this.state.progress = (simNow() - run.started) / run.pace;
      else if (shown.stage === "Sown" && shown.growth < 1 && performance.now() - looked > 500) {
        looked = performance.now();
        shown = lookOf(land);
        this.state.after = this.vec(shown);
      }
      this.raise();
      markMaterialUboDirty(this.material);
    });
  }

  private vec = (l: Look) => [STAGES.indexOf(l.stage), l.growth, 0, 0];

  /** The field between runs: one look, every tile done. */
  private lay(look: Look) {
    this.state = { before: this.vec(look), after: this.vec(look), progress: 1e9 };
    for (let i = 0; i < this.tiles.length; i++) this.data.set([0, 0, 0], i * 8 + 1);
  }

  /** A run out over the field, or none: each tile told when the tractor
   *  works it, and which way it is heading then. */
  private follow(run: Run | null, look: Look) {
    // A run just over leaves what it did, until the farm's new record
    // comes to say so.
    const ended = this.run && !run;
    this.run = run;
    if (!run) {
      this.lay(ended ? { stage: STAGES[this.state.after[0]] as Look["stage"], growth: this.state.after[1] } : look);
    } else {
      this.state.before = this.vec(look);
      this.state.after = this.vec(leaves(run.job, look));
      const path = run.path;
      const at = (t: GridCoord) => this.key.get(`${t.x},${t.y}`);
      // The headland is worked on its own pass round: when ploughing,
      // after the lands, so not before the last land tile is first
      // reached; else the first time over it.
      const firsts = new Map<number, number>();
      path.forEach((t, k) => { const i = at(t); if (i !== undefined && !firsts.has(i)) firsts.set(i, k); });
      const head = (i: number) => this.data[i * 8] !== 0;
      const ring = run.job === "Plough" ? Math.max(0, ...[...firsts].filter(([i]) => !head(i)).map(([, k]) => k)) : 0;
      const worked = new Map<number, number>();
      path.forEach((t, k) => {
        const i = at(t);
        if (i === undefined || worked.has(i) || (head(i) && k < ring)) return;
        worked.set(i, k);
      });
      for (let i = 0; i < this.tiles.length; i++) {
        const k = worked.get(i) ?? firsts.get(i) ?? -1;
        const [a, b] = [path[Math.max(0, k - 1)], path[Math.min(path.length - 1, k + 1)]];
        const [hx, hy] = k < 0 ? [0, 0] : [b.x - a.x, b.y - a.y];
        const len = Math.hypot(hx, hy) || 1;
        this.data.set([k, hx / len, hy / len], i * 8 + 1);
      }
    }
    setMeshAttribute(this.ctx.engine, this.mesh, "field", this.data);
  }

  /** Each tile at the height of what stands on it: the crop, until the
   *  tractor is past its middle. */
  private raise() {
    const { before, after, progress } = this.state;
    const look = (v: number[]): Look => ({ stage: STAGES[v[0]] as Look["stage"], growth: v[1] });
    const [hb, ha] = [heightOf(look(before)), heightOf(look(after))];
    let changed = false;
    const heights = this.tiles.map((_, i) => {
      const h = this.data[i * 8 + 1] < progress ? ha : hb;
      if (Math.abs(h - this.heights[i]) > 0.002) changed = true;
      return h;
    });
    if (!changed) return;
    this.heights = heights;
    const matrices = new Float32Array(this.tiles.length * 16);
    this.tiles.forEach((t, i) => {
      const m = i * 16;
      [matrices[m], matrices[m + 5], matrices[m + 10], matrices[m + 15]] = [1, 1, 1, 1];
      [matrices[m + 12], matrices[m + 13], matrices[m + 14]] = [t.x, t.y, FIELD_Z + heights[i]];
    });
    setThinInstances(this.mesh, matrices, this.tiles.length);
  }

  /** The field's paint (see the top), a tile's mask, when it is worked
   *  and which way, and the way across its lands, read per tile. */
  private plugin(engine: Engine): MaterialPlugin {
    return {
      name: "Field",
      priority: 210,
      getAttributes: () => [
        { name: "fieldA", type: "vec4<f32>", perInstance: true, buffer: "field" },
        { name: "fieldB", type: "vec4<f32>", perInstance: true, buffer: "field" },
      ],
      getVaryings: () => [
        { name: "vFieldAt", type: "vec2f" },
        { name: "vFieldA", type: "vec4f" },
        { name: "vFieldB", type: "vec4f" },
      ],
      getSamplers: () => [{ texture: "fieldGrain", sampler: "fieldGrainSampler" }],
      bindTextures: (out) => out.push({ texture: grain(engine) }),
      getUniforms: () => ({
        ubo: [
          { name: "fieldBefore", type: "vec4<f32>" },
          { name: "fieldAfter", type: "vec4<f32>" },
          { name: "fieldRun", type: "vec4<f32>" },
          { name: "fieldEarth", type: "vec4<f32>" },
          { name: "fieldGrowing", type: "vec4<f32>" },
          { name: "fieldRipe", type: "vec4<f32>" },
          { name: "fieldStubble", type: "vec4<f32>" },
          { name: "fieldSun", type: "vec4<f32>" },
        ],
      }),
      writeUbo: (data, offsets) => {
        const put = (name: string, v: number[]) => data.set(v, offsets.get(name)! / 4);
        put("fieldBefore", this.state.before);
        put("fieldAfter", this.state.after);
        put("fieldRun", [this.state.progress, 0, 0, 0]);
        ["fieldEarth", "fieldGrowing", "fieldRipe", "fieldStubble"].forEach((name, i) => put(name, [this.colours[i].r, this.colours[i].g, this.colours[i].b, 1]));
        const d = (this.ctx.scene.lights.find((l) => l.shadowGenerator) as DirectionalLight | undefined)?.direction ?? { x: 0, y: 0, z: -1 };
        put("fieldSun", [-d.x, -d.y, -d.z, 0]);
      },
      getCustomCode: (stage) =>
        stage === "vertex"
          ? { CUSTOM_VERTEX_MAIN_END: "out.vFieldAt = position.xy; out.vFieldA = fieldA; out.vFieldB = fieldB;" }
          : { CUSTOM_FRAGMENT_DEFINITIONS: DEFINITIONS, CUSTOM_FRAGMENT_MAIN_BEGIN: BEGIN, CUSTOM_FRAGMENT_UPDATE_DIFFUSE: DIFFUSE },
    };
  }

  dispose(): void {
    this.stop();
    this.casters.remove(this.mesh);
    drop(this.ctx.scene, this.mesh);
  }
}

/** The grain, as value noise: `p` in its texels, 256 to its side. And
 *  the field's height across its passes, `u` (see BEGIN), by stage, and of
 *  that how much is crop: the furrow slices, each turned over against the
 *  last, rising across it and falling steep to the next; the drill rows,
 *  the crop up along them, closing over them, the tramlines, the wheel
 *  tracks of every other pass, cut down to the earth; the stubble, its
 *  straw in a windrow down the middle of each pass. As high as the crop
 *  stands (CROP_H) and as deep as the shadows cast into it. */
const DEFINITIONS = `fn fieldNoise(p: vec2f) -> f32 { return textureSample(fieldGrain, fieldGrainSampler, p / 256.).r; }
fn fieldHeight(u: f32, stage: u32, k: f32) -> vec2f {
  let p = fract(u);
  if (stage == 1u) { let q = fract(u * 4.); return vec2f(0.035 * pow(q, 0.6) * (1. - smoothstep(0.78, 1., q)), 0.); }
  if (stage == 2u) {
    let grown = smoothstep(0.03, 0.6, k);
    let row = 1. - abs(fract(u * 6.) - 0.5) * 2.;
    let tram = select(0., 1., fract(floor(u) * 0.5) < 0.25) * (1. - smoothstep(0.035, 0.05, min(abs(p - 0.4), abs(p - 0.6))));
    let crop = smoothstep(1. - grown * 1.5, 1.25 - grown * 1.5, row) * smoothstep(0., 0.05, k) * (1. - tram);
    return vec2f(${CROP_H.toFixed(3)} * crop * (0.15 + 0.85 * grown) + 0.014 * row * (1. - tram), crop);
  }
  if (stage == 3u) { let s = 1. - smoothstep(0.05, 0.13, abs(p - 0.5)); return vec2f(0.01 + 0.025 * s * s, s); }
  return vec2f(0.);
}`;

/**
 * Where in the field a pixel is: how far from its edge, and which way
 * that grows, if its tile is headland (`fieldD`, `fieldAcross`); else the
 * way across the lands. Then `fieldU`, the distance across the passes, a
 * pass a tile wide, its middle at a half, and `fieldV` along them. Every
 * texture read here, before anything branches, as WGSL wants.
 */
const BEGIN = `let fieldAt = input.vFieldAt;
let fieldMask = u32(input.vFieldA.x + 0.5);
var fieldD = 9.;
var fieldAcross = input.vFieldB.xy;
if ((fieldMask & 1u) != 0u && 1. - fieldAt.x < fieldD) { fieldD = 1. - fieldAt.x; fieldAcross = vec2f(-1., 0.); }
if ((fieldMask & 2u) != 0u && fieldAt.x < fieldD) { fieldD = fieldAt.x; fieldAcross = vec2f(1., 0.); }
if ((fieldMask & 4u) != 0u && 1. - fieldAt.y < fieldD) { fieldD = 1. - fieldAt.y; fieldAcross = vec2f(0., -1.); }
if ((fieldMask & 8u) != 0u && fieldAt.y < fieldD) { fieldD = fieldAt.y; fieldAcross = vec2f(0., 1.); }
for (var b = 4u; b < 8u; b++) {
  let corner = vec2f(select(0., 1., b == 4u || b == 5u), select(0., 1., b == 4u || b == 6u));
  let off = fieldAt - corner;
  let d = length(off);
  if ((fieldMask & (1u << b)) != 0u && d < fieldD) { fieldD = d; fieldAcross = off / max(d, 1e-4); }
}
// An outside corner, field on two sides of it, is turned round on an arc
// a tile across, as a tractor turns, about the corner of the tile inside
// it; past the arc, grass.
let fieldSideX = fieldMask & 3u;
let fieldSideY = (fieldMask >> 2u) & 3u;
if ((fieldSideX == 1u || fieldSideX == 2u) && (fieldSideY == 1u || fieldSideY == 2u)) {
  let inner = vec2f(select(1., 0., fieldSideX == 1u), select(1., 0., fieldSideY == 1u));
  let off = fieldAt - inner;
  let r = length(off);
  fieldD = 1. - r;
  fieldAcross = -off / max(r, 1e-4);
}
let fieldHead = fieldMask != 0u;
let fieldU = select(dot(input.worldPos.xy, fieldAcross), fieldD, fieldHead);
let fieldAlong = vec2f(-fieldAcross.y, fieldAcross.x);
let fieldV = dot(input.worldPos.xy, fieldAlong);
let fieldW = input.worldPos.xy;
let fieldN1 = fieldNoise(fieldW * 48.);
let fieldN2 = fieldNoise(fieldW * 48. + vec2f(97., 41.));
let fieldStreak = fieldNoise(vec2f(fieldU * 72., fieldV * 5.));
let fieldStreak2 = fieldNoise(vec2f(fieldU * 72. + 1.5, fieldV * 5.));
// How far off the field is: as a pass shrinks to a few pixels, its
// ridges and rows and shade are drawn as what they add up to, or shimmer.
let fieldFar = smoothstep(0.03, 0.1, fwidth(fieldU));
// Broad, soft patches: wetter earth, a crop a little ahead or behind.
let fieldMottle = 0.6 * fieldNoise(fieldW * 2. + vec2f(61., 7.)) + 0.4 * fieldNoise(fieldW * 6. + vec2f(13., 89.));
let fieldEdge = 0.5 * fieldNoise(fieldW * 24. + vec2f(31., 5.)) + 0.5 * fieldNoise(fieldW * 6. + vec2f(3., 201.));
// The tractor's job is done here, or not yet.
let fieldK = input.vFieldA.y;
let fieldDone = fieldK - 0.5 + dot(fieldAt - 0.5, input.vFieldA.zw) + 0.5 < material.fieldRun.x;
let fieldLook = select(material.fieldBefore, material.fieldAfter, fieldDone);
let fieldStage = u32(fieldLook.x + 0.5);
// A ragged margin of grass round the field; and grass, not yet ploughed.
if (fieldStage == 0u || fieldD < 0.03 + 0.07 * fieldEdge) { discard; }`;

/**
 * The paint, by stage: a colour, the crop's from the earth's by how much
 * of the height is crop; the height's slope tilting the facing, so the
 * ridges and the walls of the tramlines take the light; the shade a ridge
 * or the crop casts across the passes, found by stepping toward the sun
 * until something stands higher than the ray (fades out where a pass is
 * a few pixels, and at night); the bottoms of the furrows and tracks a
 * little darker than the tops. Over it a jumble, the fine grain's, of
 * clods, ears, stalks.
 */
const DIFFUSE = `let fieldGrown = fieldLook.y;
let fieldHC = fieldHeight(fieldU, fieldStage, fieldGrown);
let fieldE = 0.004;
let fieldSlope = clamp((fieldHeight(fieldU + fieldE, fieldStage, fieldGrown).x - fieldHeight(fieldU - fieldE, fieldStage, fieldGrown).x) / (2. * fieldE), -3., 3.);
let fieldSun = material.fieldSun.xyz;
let fieldToward = dot(fieldSun.xy, fieldAcross);
let fieldRise = max(fieldSun.z, 0.05) / max(abs(fieldToward), 0.05);
var fieldOver = 0.;
for (var i = 1; i <= 8; i++) {
  let du = f32(i) * 0.02;
  fieldOver = max(fieldOver, fieldHeight(fieldU + sign(fieldToward) * du, fieldStage, fieldGrown).x - fieldHC.x - du * fieldRise);
}
let fieldLit = mix(1. - smoothstep(0., 0.008, fieldOver), 0.85, fieldFar) * smoothstep(0., 0.1, fieldSun.z) + 1. - smoothstep(0., 0.1, fieldSun.z);
let fieldBumps = (vec2f(fieldN1, fieldN2) - 0.5) * 2.;
// Out and back: each pass leans the other way, as a mown lawn's stripes.
let fieldWay = select(-1., 1., fract(floor(fieldU) * 0.5) < 0.25);
// A gentle tint, a few in a hundred either way, and no more.
let fieldTint = 0.94 + 0.12 * fieldMottle;
let fieldSoil = material.fieldEarth.rgb * vec3f(0.86, 0.8, 0.75);
var fieldColour = material.fieldEarth.rgb;
var fieldTop = 1.;
var fieldLean = 0.;
var fieldJumble = 0.;
if (fieldStage == 1u) {
  // Ploughed: turned earth, four furrow slices a pass, clods all over.
  fieldColour = material.fieldEarth.rgb * vec3f(0.68, 0.6, 0.54);
  fieldTop = fieldHC.x / 0.035;
  fieldJumble = 0.55;
} else if (fieldStage == 2u) {
  // Sown: green, then gold, the tips of the crop lighter than its feet.
  let crop = mix(material.fieldGrowing.rgb * vec3f(0.62, 0.78, 0.55), material.fieldRipe.rgb * vec3f(0.95, 0.88, 0.7), smoothstep(0.6, 1., fieldGrown)) * (0.97 + 0.06 * fieldStreak);
  fieldColour = mix(fieldSoil, crop, mix(fieldHC.y, smoothstep(0.1, 0.5, fieldGrown), fieldFar));
  fieldTop = fieldHC.x / ${CROP_H.toFixed(3)};
  fieldLean = fieldHC.y * (0.25 * (fieldStreak2 - fieldStreak) * 6. + 0.2 * fieldWay);
  fieldJumble = 0.15 + 0.15 * fieldHC.y;
} else if (fieldStage == 3u) {
  // Stubble: straw cut short, each pass leaning the way the combine went;
  // the windrow paler.
  fieldColour = mix(material.fieldStubble.rgb, material.fieldRipe.rgb, 0.35 + 0.25 * fieldHC.y);
  fieldTop = 0.5 + 0.5 * fieldHC.y;
  fieldLean = 0.45 * fieldWay + fieldHC.y * 0.5 * (fieldStreak2 - fieldStreak) * 6.;
  fieldJumble = 0.3;
}
fieldColour = fieldColour * fieldTint * mix(0.72, 1.05, mix(clamp(fieldTop, 0., 1.), 0.7, fieldFar)) * mix(0.62, 1., fieldLit);
baseColor = fieldColour;
N = normalize(N - vec3f(fieldAcross * (fieldSlope * (1. - fieldFar) + fieldLean), 0.) + vec3f(fieldBumps * fieldJumble, 0.));`;
