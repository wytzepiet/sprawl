import type { JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { BuildingKind } from "../generated";

/**
 * What each kind of building is, as a filled silhouette. Drawn on a 24-unit
 * grid in the solid style — one shape, windows and doors cut out of it — so
 * a pin reads at a glance and still reads shrunk to a dot's neighbour.
 */
type IconProps = JSX.SvgSVGAttributes<SVGSVGElement>;

function Icon(props: IconProps & { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true" {...props}>
      <path d={props.d} />
    </svg>
  );
}

/** A gabled roof over a body, the door cut out. */
export const House = (p: IconProps) => (
  <Icon {...p} d="M12 2.5 1.5 11.5H4.5V21.5H19.5V11.5H22.5ZM10 14h4v7.5h-4z" />
);

/** A tall block, three floors of windows and a door. */
export const Apartment = (p: IconProps) => (
  <Icon
    {...p}
    d="M5 2h14v20H5zM8 5h3v3H8zM13 5h3v3h-3zM8 10h3v3H8zM13 10h3v3h-3zM8 15h3v3H8zM13 15h3v3h-3zM10.5 19h3v3h-3z"
  />
);

/** A storefront: scalloped awning, window and door beneath. */
export const Shop = (p: IconProps) => (
  <Icon
    {...p}
    d="M3 3h18l2 5.5a2.5 2.5 0 0 1-4.7 1.2A2.5 2.5 0 0 1 14.2 9.7a2.5 2.5 0 0 1-4.4 0 2.5 2.5 0 0 1-4.1 0A2.5 2.5 0 0 1 1 8.5zM4 12h16v10H4zM6 14h6v4H6zM14 14h4v8h-4z"
  />
);

/** A briefcase, the handle cut out. */
export const Office = (p: IconProps) => (
  <Icon
    {...p}
    d="M9 3h6a1.5 1.5 0 0 1 1.5 1.5V7H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3.5V4.5A1.5 1.5 0 0 1 9 3zm.5 2v2h5V5zM2 12h20v1.5H2z"
  />
);

/** A wrench. */
export const Workshop = (p: IconProps) => (
  <Icon
    {...p}
    d="M21.5 6.2a6.3 6.3 0 0 1-8.1 8.1l-7.3 7.3a2.3 2.3 0 0 1-3.2-3.2l7.3-7.3a6.3 6.3 0 0 1 8.1-8.1l-3.7 3.7 1.1 3.2 3.2 1.1z"
  />
);

/** Sawtooth roofs and a chimney. */
export const Factory = (p: IconProps) => (
  <Icon
    {...p}
    d="M17 2h4v8.5l-4 0zM2 22V10.5l6 3v-3l6 3v-3l6 3V22zM5 16h3v3H5zM10 16h3v3h-3zM15 16h3v3h-3z"
  />
);

/** Fork and knife. */
export const Restaurant = (p: IconProps) => (
  <Icon
    {...p}
    d="M5.5 2h1.6v6h1.2V2h1.4v6h1.2V2h1.6v7a3.5 3.5 0 0 1-2.2 3.3V22H7.7v-9.7A3.5 3.5 0 0 1 5.5 9zM15.5 2c2.2 1.6 3.3 4.6 3.3 8 0 1.8-.8 3-1.9 3.6V22h-2.3V2z"
  />
);

export const BUILDING_ICONS: Record<BuildingKind, (p: IconProps) => JSX.Element> = {
  House,
  Apartment,
  Shop,
  Office,
  Workshop,
  Factory,
  Restaurant,
};

/** The icon for a kind, by name. */
export function BuildingIcon(props: IconProps & { kind: BuildingKind }) {
  return <Dynamic component={BUILDING_ICONS[props.kind]} {...props} />;
}
