import { BLUEPRINTS, BuildingIcon } from "../blueprints";
import type { BuildingKind } from "../generated";

/**
 * The pin outline: a circle of radius 10 at the origin, and a point at (0,18).
 * The two straight edges are the tangents from that point to the circle, so
 * they leave the arc at the same slope it ends on — one shape, not a disc with
 * a triangle stuck under it. Tangent points are at (±r·sinθ, r·cosθ) where
 * cosθ = r/d, which for r=10, d=18 puts them at (±8.315, 5.556).
 *
 * How far the point sits below the centre is the whole look: the further out,
 * the narrower the taper. At d=18 the apex is 67.5° and the straight run is 15
 * units, against the circle's 20 of width.
 */
const OUTLINE = "M-8.315 5.556A10 10 0 1 1 8.315 5.556L0 18Z";

/**
 * The pin proper — tail and head — for a kind of building. The map's pins
 * and the build menu's previews are the same pin; styled under `.pins`.
 */
export function PinBody(props: { kind: BuildingKind; dormant?: boolean }) {
  return (
    <div class="body">
      {/* The tail is its own square box centred on the disc. The shadow is a
          second outline a pixel down, not a filter: a filter is repainted
          per pin per frame, and a city has hundreds of pins. */}
      <svg class="tail" viewBox="-19 -19 38 38">
        <path d={OUTLINE} fill="rgba(0,0,0,0.3)" transform="translate(0.4 1.2)" />
        <path d={OUTLINE} fill="#fff" stroke={props.dormant ? "#D9483B" : "none"} stroke-width="1.5" />
      </svg>
      <svg class="head" viewBox="-11 -11 22 30">
        {/* The disc nearly fills the head: the white is a rim on the colour,
            not a field it floats in. */}
        <circle r="7.8" fill={BLUEPRINTS[props.kind].color} />
        <BuildingIcon kind={props.kind} class="glyph text-white" x="-6.5" y="-6.5" width="13" height="13" />
      </svg>
    </div>
  );
}
