/**
 * A colour, as the town's palette and its lights are written: red, green and
 * blue, 0 to 1 for a colour an eye sees, past 1 where a light is brighter
 * than white. Plain values, never changed in place.
 */
export type Rgb = { readonly r: number; readonly g: number; readonly b: number };

export const rgb = (r: number, g: number, b: number): Rgb => ({ r, g, b });

export const WHITE = rgb(1, 1, 1);
export const BLACK = rgb(0, 0, 0);

/** `#RRGGBB`. */
export function hex(h: string): Rgb {
  const n = parseInt(h.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export const lerp = (a: Rgb, b: Rgb, t: number): Rgb => rgb(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
export const scale = (c: Rgb, s: number): Rgb => rgb(c.r * s, c.g * s, c.b * s);
export const mul = (a: Rgb, b: Rgb): Rgb => rgb(a.r * b.r, a.g * b.g, a.b * b.b);
export const add = (a: Rgb, b: Rgb): Rgb => rgb(a.r + b.r, a.g + b.g, a.b + b.b);

/** As light: the colour an eye sees, made linear. */
export const linear = (c: Rgb): Rgb => rgb(c.r ** 2.2, c.g ** 2.2, c.b ** 2.2);

export const tuple = (c: Rgb): [number, number, number] => [c.r, c.g, c.b];
