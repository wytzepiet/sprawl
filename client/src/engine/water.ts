import type { Rgb } from "./rgb";
import { createTexture2DFromPixels, markMaterialUboDirty, type EngineContext, type MaterialPlugin, type Texture2D } from "./gpu";
import { retire } from "./geometry";
import { townMaterial } from "./material";
import { CHUNK_SIZE, CLIFF_REACH, CLIFF_RUN, CLIFF_WANDER, LEAN, SHORE_DENSITY, SHORE_REACH, WATER_Z } from "./objects/terrainGeometry";
import { AFLOAT, CALM, cliffUv, ledgeOut, slateRead } from "./peaks";
import { slate } from "./slateTexture";
import { SPAN as SLATE_SPAN } from "./slate";
import { LACE_TILES, lace } from "./lace";
import { ripples } from "./waves";

/**
 * The sea and the lakes, drawn as water: their own meshes (`terrainGeometry`
 * keeps them apart from the ground) on their own material, lacquered to
 * gleam. The surface's facing is turned this way and that by a ripple read
 * twice from one tiling texture, at two sizes drifting different ways, as
 * water shaders do: the two never fall in step, so the pattern never shows
 * itself, and the sun's glint breaks up and wanders on it as on open water.
 *
 * Each chunk's water knows how far it lies from land (`shoreField`), and
 * takes that for its depth. Near the shore one sees the sandy bottom
 * through it, tinted by the water; further out the bottom fades into the
 * water's own deeper colour. Along the shore lies a band of foam, its edge
 * ragged with the same ripple and lapping in and out, and crests of it
 * running in, one each `WAVE_PERIOD`, to break on it; under a cliff, along
 * its wall's foot (`peaks.ts`), the same field telling where. All of it is
 * lit as
 * any ground is, so it dims and takes the light's colour by night.
 */

/** Each reading of it: how many tiles it spans, which way it drifts and
 *  how fast, in tiles a second, how far it tilts the surface, and how far
 *  it is turned, so the readings' grids never line up into a repeat. */
const LAYERS: [number, number, number, number, number, number][] = [
  [5.3, 0.8, 0.6, 0.12, 0.22, 0.31],
  [2.9, -0.5, 0.86, 0.09, 0.14, -0.83],
];

/** Deep water: the water's own colour, this dark. How far one sees down
 *  through it, in tiles: the bottom shows less by e the further out. How
 *  much the water tints the bottom seen through it. */
const DEEP = 0.55;
/** The surface, near enough smooth: the sun's glint broken up only by the
 *  ripple's facing. */
const WATER_ROUGHNESS = 0.17;
const CLARITY = 0.6;
/** Pale sand under clear water, the red drunk out of the light: turquoise,
 *  as off a Hebridean beach; and right at the sand, barely any water over
 *  it, all but white, within this far of the shore, in tiles. */
const TURQUOISE = [0.32, 0.72, 0.66];
const PALE = [0.8, 0.93, 0.89];
const NEAR = 0.18;
/** How far out the foam reaches, at most, in tiles, and how white it is:
 *  over white, as foam seems, the light scattered through it. */
const FOAM = 0.3;
const FOAM_WHITE = 1.2;
/** Where it is thin, fading or at its edge, this white, a greyer foam. */
const FOAM_THIN = 0.75;
/** Only the thickest of it reaching the brightest: its thickness to this
 *  power, so pure white is scarce. */
const FOAM_SCARCE = 3;
/** And as rough as chalk, where the sea is glossy. */
const FOAM_ROUGH = 0.95;
/** The waves washing ashore: one every this many seconds (a whole part of
 *  the hour the clock wraps at), a crest of foam running in from this far
 *  out, in tiles, as wide as this; and as it breaks it runs up a beach as
 *  far as this, the sand drawing back from it (`ground.ts`). */
const WAVE_PERIOD = 6;
const WAVE_FROM = 1.6;
const CREST = 0.035;
/** And this share of that where the waves start, out to sea. */
const CREST_FAR = 0.31;
/** And sparser there, its cracks cutting this much more of it. */
const CREST_SPARSE = 3;
/** The swell carrying each crest: this high, in tiles; its front, ashore,
 *  this share of a wave, a hollow ramp curving up to its lip, steeper the
 *  higher, as this power; its back, out to sea, the rest, rounding down;
 *  its lip this far through a wave out past where the crest's white
 *  begins, the white running down its front. */
const SWELL_HEIGHT = 0.11;
const SWELL_FRONT = 0.3;
const SWELL_CURL = 3;
/** The top this share of its front rounding over into its back, not
 *  meeting it at an edge, where the sky would catch as a line. */
const SWELL_ROUND = 0.35;
const SWELL_AHEAD = 0;
/** How ragged the crest's white is, of its whole; and how far it trails
 *  out to sea past the lip, in tiles, fading as it goes. */
const CREST_JAG = 0.35;
/** And how far its edge goes round the grain's cells, whole cells kept or
 *  lost, rather than one smooth line across them. */
const CREST_SHAPE = 0.6;
const CREST_TAIL = 0.08;
/** And how far its white thins toward the water in patches, with the
 *  same grain, from none to all of it. */
const CREST_MOTTLE = 0.85;
/** Where the waves come in, the open sea's ripples are this much of
 *  themselves. */
const INSHORE_CALM = 0.2;
export const SWASH = 0.26;
/** The swash starts up the sand this far through a wave before the crest
 *  reaches it, as the broken water runs ahead of its white. */
const SWASH_LEAD = 0.06;
/** And a wave runs up for this share of itself, back down for the rest. */
const RISE = 0.3;
/** A wave breaks where it is lost in the foam and leaves lace behind it,
 *  this far out from the shore at most, in tiles: all of it white as it
 *  breaks, its holes opening, its strands parting, then gone by this far
 *  through the wave, but for this share at the water's edge; and drawn back
 *  out this far as the swash runs back. */
const LACE_REACH = 1;
const LACE_LIFE = 0.5;
const LACE_LEFT = 0.2;
/** The lace whole as it is left, this opaque as it thins away; and solid
 *  only this far into a strand past where it shows, of the texture's
 *  depth. */
const LACE_SHOW = 0.5;
const LACE_SOFT = 0.4;
const LACE_DRIFT = 0.15;
/** Further out, where the waves are only coming in, each leaves this much
 *  of a lace behind it, thinning out where the waves start. */
const LACE_FAR = 0.35;
/** Round the rocks the sea is always broken: a fuzz of foam within this
 *  far of a cliff's ledge, in tiles, its grain this many tiles across,
 *  churning this fast, in tiles a second. */
const ROCK_REACH = 0.08;
/** And the sea breaks white only this close to rock, in tiles. */
const ROCK_BREAK = 0.5;
const FUZZ_TILES = 0.7;
const FUZZ_CHURN = 0.02;
/** Not one wave for the whole coast: the ripple's height, read this many
 *  tiles across, puts a stretch of shore this many waves behind or ahead;
 *  and read again this many tiles across, afresh for every wave, breaks
 *  each crest into pieces, where it is over this. The beach's swash reads
 *  them alike (`ground.ts`). */
const WAVE_STAGGER = [61, 1.6];
/** The swell comes in from the wind's way, not square to every coast: a
 *  wave's phase climbs this much a tile along it, so its crests meet a
 *  shore at a slant and break along it in turn. */
const SLANT = [0.92, 0.39].map((v) => (v * Math.tan((8 * Math.PI) / 180)) / WAVE_FROM);
/** And each crest wiggles: the ripple's height, read this many tiles
 *  across, putting a stretch up to this many tiles ahead or behind. */
const WIGGLE = [3.7, 0.13];
const WAVE_PIECES = [14, -0.05];
/** A wave's phase at a point of the map: `R(uv)` reads the ripple's height
 *  there, `t` the clock, `d` how far through it the point is. */
const wavePhase = (R: (uv: string) => string, at: string, t: string, d: string) =>
  `(${t} / ${f(WAVE_PERIOD)} + ${d} + ${R(`${at} / ${f(WAVE_STAGGER[0])}`)} * ${f(WAVE_STAGGER[1])} + dot(${at}, vec2f(${f(SLANT[0])}, ${f(SLANT[1])})))`;
/** Whether a wave of that phase reaches a point, 0 to 1. */
const wavePiece = (R: (uv: string) => string, at: string, phase: string) =>
  `smoothstep(${f(WAVE_PIECES[1] - 0.08)}, ${f(WAVE_PIECES[1] + 0.08)}, ${R(`${at} / ${f(WAVE_PIECES[0])} + floor(${phase}) * vec2f(0.37, 0.61)`)})`;

/** How far up the shore the water is, of its furthest, at a point `p` of
 *  the map at time `t`: from just before its wave's crest reaches the
 *  shore, surging up, slowing as it climbs, then back down; `R(uv)` reads
 *  the ripple's height. A WGSL function of that name, for the beach and the
 *  rock alike (`ground.ts`, `peaks.ts`). */
export const swashFn = (R: (uv: string) => string, name: string) =>
  `fn ${name}(t: f32, p: vec2f) -> f32 { let w = ${wavePhase(R, "p", "t", f(SWASH_LEAD))}; let s = fract(w); let up = 1. - min(s / ${f(RISE)}, 1.); return min(1. - up * up, 1. - smoothstep(${f(RISE)}, 1., s)) * mix(0.25, 1., ${wavePiece(R, "p", "(w - 1.)")}); }`;

const f = (x: number) => x.toFixed(4);
const FAR = new Uint8Array([255]);
/** How far out from the cliff's wall's foot a point is, by the cliff's
 *  field there (`cliff.ts`), in tiles; as far as the field reaches is no
 *  cliff near at all. */
const footOf = (field: string) => `((${field} - 0.5) * ${f(2 * CLIFF_REACH)} - ${f(CLIFF_RUN)} + step(0.995, ${field}) * 9.)`;
/** How far in over the rock a wave washes from its ledge's broken edge at
 *  most, in tiles; and how far in a step up the wall counts for, a tile of
 *  height: the higher this, the less of the wall a wave reaches. */
const [WASH, STEEP] = [0.3, 2];

/** How far each way the water looks for which way is out to sea, in tiles. */
const SEAWARD_OVER = 2 / SHORE_DENSITY;
/** How far ashore a point of a chunk is: from its shore or its cliff's
 *  foot, the nearer. */
const ASHORE_AT = `fn ashoreAt(p: vec2f) -> f32 {
  let shore = textureSampleLevel(waterShore, waterShoreSampler, p / ${f(CHUNK_SIZE)}, 0.).r * ${f(SHORE_REACH)};
  return min(shore, max(${footOf(`textureSampleLevel(waterCliff, waterCliffSampler, ${cliffUv("p")}, 0.).r`)}, 0.));
}`;

const water = (surf: Rgb | null) => {
  const [at, here, time] = ["input.worldPos.xy", "input.vWaterAt", "material.waterTime"];
  const read = (tex: string, uv: string) => `textureSample(${tex}, ${tex}Sampler, ${uv})`;
  // Where a reading is on the texture: drifting, then turned.
  const drift = ([span, dx, dy, speed, , turn]: number[]) => {
    const [c, s] = [Math.cos(turn), Math.sin(turn)];
    const p = `(${at} - vec2f(${f(dx)}, ${f(dy)}) * ${f(speed)} * ${time})`;
    return `vec2f(${p}.x * ${f(c)} - ${p}.y * ${f(s)}, ${p}.x * ${f(s)} + ${p}.y * ${f(c)}) / ${f(span)}`;
  };
  // Its slope, turned back to the map's frame.
  const slope = LAYERS.map((l, i) => {
    const [c, s] = [Math.cos(l[5]), Math.sin(l[5])];
    const g = i === 0 ? "ripple.rg" : `${read("waterRipple", drift(l))}.rg`;
    return `vec2f(${g}.x * ${f(c)} + ${g}.y * ${f(s)}, ${g}.y * ${f(c)} - ${g}.x * ${f(s)}) * ${f(l[4])}`;
  }).join(" + ");
  // The slate at the pixel, as the cliff's lip wanders along it, for the
  // waves to keep time by its smooth outline.
  const slateTop = `textureSampleBias(waterSlate, waterSlateSampler, ${at} / ${f(SLATE_SPAN)}, ${f(CALM)})`;
  // The ripple's height, for the waves' timing: broad, read whole, as
  // each wave reads it afresh, a jump the sampler would take for a blur.
  const height = (uv: string) => `textureSampleLevel(waterRipple, waterRippleSampler, ${uv}, 0.).b`;
  // The crest's white is whole up to here through a wave, its lip, then
  // trails off out to sea.
  const lip = 1 - CREST_TAIL / WAVE_FROM;
  return [
    // How far from the shore (`shore.ts`).
    `let shore = ${read("waterShore", `${here} / ${f(CHUNK_SIZE)}`)}.r * ${f(SHORE_REACH)};`,
    // The sea's broadest ripple: its slope, and its height, the swell.
    `let ripple = ${read("waterRipple", drift(LAYERS[0]))};`,
    `let swell = ripple.b;`,
    `let foamEdge = ${f(FOAM)} * (0.5 + 0.5 * swell) * (0.85 + 0.15 * sin(1.3 * ${time}));`,
    `let cliffField = ${read("waterCliff", cliffUv(here))}.r;`,
    `let slate = ${slateTop};`,
    // How far out from the cliff's foot, its lip wandering along the slate
    // (`cliffField`); as far as the field reaches is no cliff near at all.
    `let cliffFoot = ${footOf("cliffField")};`,
    `let ashore = min(shore, max(cliffFoot, 0.));`,
    // The rock at its foot rises from its ledge's edge, broken along the
    // slate as the cliff breaks it (`peaks.ts`' `cliffBreak`): the ledge a
    // little, inland, and the wall from where it stands on the ledge, by
    // its own height. How far in from the water's edge on it a point is, as
    // a wave washes in over it, where the sea is at the rock, not a beach.
    `let ledgeOut = ${ledgeOut(at)};`,
    // On the wall, the field where the wall's foot is, straight under.
    ...(surf
      ? [
          `let rockUp = input.worldPos.z - ${f(WATER_Z)};`,
          `let rockFoot = ${footOf(`${read("waterCliff", cliffUv(`(${here} + normalize(input.worldNormal.xy + 1e-6) * rockUp * ${f(LEAN)})`))}.r`)};`,
          `let rockIn = select(ledgeOut - cliffFoot, max(ledgeOut - rockFoot, 0.) + rockUp * ${f(STEEP)}, abs(input.worldNormal.z) < 0.5);`,
        ]
      : [`let rockIn = ledgeOut - cliffFoot;`]),
    `let rockOver = ${f(WASH)} * rockWash(${time}, ${at}) * smoothstep(0., ${f(AFLOAT)}, shore) - rockIn;`,
    // The surf is the water on the rock alone, none past its ledge's broken
    // edge, where its mesh runs on: the sea's colour, not the rock's, and
    // lying as flat as the sea does, however the rock stands.
    ...(surf ? [`if (rockOver < 0. || rockIn < 0.) { discard; }`, `baseColor = vec3f(${[surf.r, surf.g, surf.b].map(f).join(", ")});`, `N = vec3f(0., 0., 1.);`] : []),
    // How the map runs across the screen, for reading the grains finely.
    `let acrossX = dpdx(${at});`,
    `let acrossY = dpdy(${at});`,
    // Nothing of the coast reaches past the shore's field, so the sea there,
    // and every chunk with no shore, does none of what follows: whole
    // stretches of pixels skip it together, so the branch costs nothing;
    // inside, nothing is read by its neighbours' readings.
    `var frothed = 0.;`,
    `var swellSlope = 0.;`,
    `var seaward = vec2f(0.);`,
    `if (ashore < ${f(SHORE_REACH - 0.01)}) {`,
    // Seaward, where the distance ashore climbs: across a few of its
    // maps' texels each way, as much of them as the chunk has, since from
    // one texel to the next it turns in steps, and the light on the swell
    // with it.
    `let seaLow = max(${here} - ${f(SEAWARD_OVER)}, vec2f(0.));`,
    `let seaHigh = min(${here} + ${f(SEAWARD_OVER)}, vec2f(${f(CHUNK_SIZE)}));`,
    `let climbs = vec2f(ashoreAt(vec2f(seaHigh.x, ${here}.y)) - ashoreAt(vec2f(seaLow.x, ${here}.y)), ashoreAt(vec2f(${here}.x, seaHigh.y)) - ashoreAt(vec2f(${here}.x, seaLow.y))) / (seaHigh - seaLow);`,
    `seaward = climbs / max(length(climbs), 1e-6);`,
    // The waves keep time by the cliff's smooth outline, not its foot's
    // wander along the slate, so their crests run smooth to the rock; and
    // wiggle of their own, a stretch a little ahead or behind.
    `let wave = ${wavePhase(height, at, time, `(min(shore, max(cliffFoot + (slate.b * 2. - 1.) * ${f(CLIFF_WANDER)}, 0.)) + ${height(`${at} / ${f(WIGGLE[0])}`)} * ${f(WIGGLE[1])}) / ${f(WAVE_FROM)}`)};`,
    // How far through its wave the water is since its crest passed; how
    // far its waves have yet to come in, fading out where they start; and
    // how far out, from the shore's foam to where they start.
    `let phase = fract(wave);`,
    // Whether the crest this belongs to has a piece here: asked after by the
    // lip its swell rises to, which the crest's white and the lace it
    // leaves agree on wherever they show; soft for the swell, and on or
    // off for the white, not the soft fade the beach's swash takes it with.
    `let owned = ${wavePiece(height, at, `(wave + ${f(SWELL_FRONT - SWELL_AHEAD)} - 1.)`)};`,
    `let ownedWhite = smoothstep(0.35, 0.65, owned);`,
    `let breaking = 1. - smoothstep(${f(WAVE_FROM * 0.6)}, ${f(WAVE_FROM)}, ashore);`,
    // Off rock the water stays deep to the stone: the swell runs in whole
    // and breaks white only close to it, not far out across a shelf as on a
    // beach. Rock where the cliff's foot is nearer than the shore's line,
    // a beach where the shore's is nearer.
    `let rocky = 1. - smoothstep(-0.3, 0.1, cliffFoot - shore);`,
    `let whiteFrom = mix(${f(WAVE_FROM)}, ${f(ROCK_BREAK)}, rocky);`,
    `let breakingWhite = 1. - smoothstep(whiteFrom * 0.6, whiteFrom, ashore);`,
    `let farOut = smoothstep(${f(FOAM)}, ${f(WAVE_FROM)}, ashore);`,
    // The lace a crest leaves behind, fresh for every wave, drawn back out
    // as the swash runs back; read as finely as the map runs under it, not
    // as its jump from one wave's pattern to the next would have it, a line
    // of blur.
    `let lace = textureSampleGrad(waterLace, waterLaceSampler, (${at} - seaward * ${f(LACE_DRIFT)} * smoothstep(0.25, 1., phase)) / ${f(LACE_TILES)} + floor(wave) * vec2f(0.37, 0.61), acrossX / ${f(LACE_TILES)}, acrossY / ${f(LACE_TILES)}).r;`,
    `let cover = max(ownedWhite * (1. - smoothstep(0., ${f(LACE_LIFE)}, phase)) * mix(1., ${f(LACE_FAR)}, smoothstep(${f(FOAM)}, ${f(LACE_REACH)}, ashore)) * breakingWhite, ${f(LACE_LEFT)} * (1. - smoothstep(foamEdge * 0.5, foamEdge, ashore)));`,
    // Two grains of lace drifting across each other: the crest's and the
    // rock's foam.
    `let fuzz = textureSampleGrad(waterLace, waterLaceSampler, (${at} + vec2f(1., 0.6) * ${f(FUZZ_CHURN)} * ${time}) / ${f(FUZZ_TILES)}, acrossX / ${f(FUZZ_TILES)}, acrossY / ${f(FUZZ_TILES)}).r + textureSampleGrad(waterLace, waterLaceSampler, (${at} - vec2f(0.5, 1.) * ${f(FUZZ_CHURN)} * ${time}) / ${f(FUZZ_TILES * 0.6)} + 0.5, acrossX / ${f(FUZZ_TILES * 0.6)}, acrossY / ${f(FUZZ_TILES * 0.6)}).r;`,
    // The wave coming in: its height across its phase, a hollow front
    // ashore curving up to its lip and a long back out to sea, faced as it
    // slopes (`SWELL_FRONT`).
    `let swellAt = fract(phase + ${f(SWELL_FRONT - SWELL_AHEAD)});`,
    `swellSlope = ${f(SWELL_HEIGHT / WAVE_FROM)} * select(${f(-Math.PI / 2 / (1 - SWELL_FRONT))} * sin(${f(Math.PI / (1 - SWELL_FRONT))} * (swellAt - ${f(SWELL_FRONT)})), ${f(SWELL_CURL / SWELL_FRONT)} * pow(swellAt / ${f(SWELL_FRONT)}, ${f(SWELL_CURL - 1)}) * (1. - smoothstep(${f(SWELL_FRONT * (1 - SWELL_ROUND))}, ${f(SWELL_FRONT)}, swellAt)), swellAt < ${f(SWELL_FRONT)}) * owned * breaking;`,
    // Its crest's white: a band up to the lip, narrower further out, and
    // trailing off out to sea past it, timed a little behind the wave so
    // the trail is its own; its edge going round the grain's cells; cut,
    // its cracks the grain's strands, wider further out, cutting it and
    // never adding to it, so none spills past it; and thinned in patches.
    `let crestAt = wave - ${f(CREST_TAIL / WAVE_FROM)};`,
    `let crestPhase = fract(crestAt);`,
    `let crestWide = ${f(CREST / WAVE_FROM)} * mix(1., ${f(CREST_FAR)}, farOut);`,
    `let crestBand = smoothstep(${f(lip)} - crestWide, ${f(lip)}, crestPhase) * (1. - smoothstep(${f(lip)}, 1., crestPhase)) * ownedWhite * breakingWhite * (1. + ${f(2 * CREST_SHAPE)} * (0.25 - fuzz * 0.5));`,
    `let crest = smoothstep(0.12, 0.35, crestBand - fuzz * 0.5 * ${f(CREST_JAG)} * (1. + ${f(CREST_SPARSE)} * farOut)) * (1. - ${f(CREST_MOTTLE)} * (1. - smoothstep(0.5, 0.75, 1. - fuzz * 0.5)));`,
    // The lace as solid as it is thick: a strand's middle whole, its edges
    // see-through, so as it ages it fades from its edges in, the thickest
    // of it last, dissolving into the sea.
    // As the lace thins, more of the texture falls under its cut and its
    // whole is less opaque; none past a full cut.
    `let laceCut = 1.05 - 1.15 * cover;`,
    `let foam = max(smoothstep(laceCut, laceCut + ${f(LACE_SOFT)}, lace) * mix(${f(LACE_SHOW)}, 1., cover), crest);`,
    // The rock's foam, thick at the water's edge on it (`rockOver`).
    `let rock = 1. - smoothstep(0., ${f(ROCK_REACH)}, rockOver);`,
    `frothed = max(foam, rock * smoothstep(0.2, 0.7, fuzz * 0.6 + rock * rock * 0.6) * 0.85);`,
    `}`,
    // The open sea's ripples, calmed where the waves come in, so theirs is
    // the shape there, and the swell's.
    `N = normalize(N + vec3f(-(${slope}) * mix(${f(INSHORE_CALM)}, 1., smoothstep(${f(WAVE_FROM * 0.5)}, ${f(SHORE_REACH)}, ashore)) - seaward * swellSlope, 0.));`,
    `baseColor = (mix(baseColor * ${f(DEEP)}, mix(vec3f(${TURQUOISE.map(f).join(", ")}), vec3f(${PALE.map(f).join(", ")}), exp(-shore / ${f(NEAR)})), exp(-shore / ${f(CLARITY)})));`,
    `baseColor = (mix(baseColor, vec3f(mix(${f(FOAM_THIN)}, ${f(FOAM_WHITE)}, pow(frothed, ${f(FOAM_SCARCE)}))), frothed));`,
    // Foam is matte, its light scattered every way, not the sea's gloss.
    `roughness = mix(roughness, ${f(FOAM_ROUGH)}, frothed);`,
  ].join("\n");
};

/** A material for one chunk's water, its colour the mesh's own, by
 *  vertex, its shore the chunk's (`shore.ts`), if it has one, its land's
 *  cliff as `cliffField` gives it. Its clock ticks before each frame
 *  (`tick`); its own textures are let go with `dispose`. Where on its chunk a
 *  pixel is: the mesh's own frame, however placed. Or its `surf`'s, the
 *  sea's colour given: the same water where a wave has washed in over the
 *  rock and nowhere else, for the cliff's wall and ledge, drawn again, so
 *  the sea lies on the rock itself (`TerrainChunks`). */
export function waterMaterial(engine: EngineContext, shore: Texture2D | null, cliff: Texture2D | null, surf: Rgb | null = null) {
  // As far from either as each reaches, where there is none.
  const far = shore && cliff ? null : createTexture2DFromPixels(engine, FAR, 1, 1, { format: "r8unorm" });
  const plugin: MaterialPlugin = {
    name: "Water",
    priority: 210,
    getVaryings: () => [{ name: "vWaterAt", type: "vec2f" }],
    getSamplers: () => ["waterRipple", "waterShore", "waterCliff", "waterSlate", "waterLace"].map((name) => ({ texture: name, sampler: `${name}Sampler` })),
    bindTextures: (out) => out.push({ texture: ripples(engine) }, { texture: shore ?? far! }, { texture: cliff ?? far! }, { texture: slate(engine) }, { texture: lace(engine) }),
    getUniforms: () => ({ ubo: [{ name: "waterTime", type: "f32" }] }),
    // Seconds, wrapped so a long session keeps the drift's precision.
    writeUbo: (data, offsets) => void (data[offsets.get("waterTime")! / 4] = (performance.now() / 1000) % 3600),
    getCustomCode: (stage) => (stage === "vertex" ? { CUSTOM_VERTEX_MAIN_END: "out.vWaterAt = position.xy;" } : { CUSTOM_FRAGMENT_DEFINITIONS: `${slateRead("waterSlate")}\n${ASHORE_AT}\n${swashFn((uv) => `textureSampleLevel(waterRipple, waterRippleSampler, ${uv}, 0.).b`, "rockWash")}`, CUSTOM_FRAGMENT_UPDATE_DIFFUSE: water(surf) }),
  };
  const material = townMaterial([plugin], WATER_ROUGHNESS);
  material.doubleSided = !!surf;
  return {
    material,
    tick: () => markMaterialUboDirty(material),
    dispose: () => far && retire(far),
  };
}
