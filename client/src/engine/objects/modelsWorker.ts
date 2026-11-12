import { bevelled } from "../creases";
import type { Built, Finish } from "./kit";
import type { Shape } from "./sea";
import { SHOP_HALL } from "./shop";
import { FISHERY } from "./fishery";
import { HOUSES } from "./house";
import { FARM } from "./farm";
import { CLAY_PIT, SAND_PIT } from "./quarry";
import { SAWMILL, WOODCUTTER } from "./sawmill";
import { BAKERY, BRICKWORKS, GLASSWORKS, SHEEP_FARM, TAILOR, WORKSHOP } from "./trades";
import type { Ask, Made } from "./models";

/** The buildings' models, made off the main thread (`models.ts`): each
 *  built when first asked for, its creases found, and handed back in
 *  arrays. */
const MODELS: Record<string, Built> = {
  ...Object.fromEntries(HOUSES.map((h, k) => [`house${k}`, h])),
  shopHall: SHOP_HALL, fishery: FISHERY, farm: FARM, sheepFarm: SHEEP_FARM, tailor: TAILOR, woodcutter: WOODCUTTER, clayPit: CLAY_PIT, sandPit: SAND_PIT,
  bakery: BAKERY, sawmill: SAWMILL, brickworks: BRICKWORKS, glassworks: GLASSWORKS, workshop: WORKSHOP,
};

/** A shape seen in a mirror across x = 0, wound round again. */
function mirror(s: Shape): Shape {
  const flip = (a: number[]) => a.map((v, i) => (i % 3 === 0 ? -v : v));
  return { ...s, positions: flip(s.positions), normals: flip(s.normals), indices: s.indices.map((_, i) => s.indices[i - (i % 3) + [0, 2, 1][i % 3]]) };
}

onmessage = ({ data: { name, notch, side } }: MessageEvent<Ask>) => {
  const built = notch ? MODELS[name].notched(...notch) : MODELS[name];
  const sent: ArrayBuffer[] = [];
  const floats = (a: ArrayLike<number>) => (sent.push(new Float32Array(a).buffer), new Float32Array(sent[sent.length - 1]));
  const finishes = (Object.entries(built.finishes) as [Finish, Shape][]).map(([k, s]): Made["finishes"][number] => {
    const g = bevelled(side > 0 ? s : mirror(s));
    return [k, { positions: floats(g.positions), normals: floats(g.normals), indices: new Uint32Array(g.indices), uvs: floats(g.uvs!), colors: floats(g.colors!), across: g.across.map(floats), reach: floats(g.reach), at: floats(g.at) }];
  });
  postMessage({ finishes, side, props: built.props, trees: built.trees } satisfies Made, { transfer: sent });
};
postMessage("ready");
