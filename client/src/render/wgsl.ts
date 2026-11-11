/** A shader's source, written as a template: marks it for the editor, and joins its parts. */
export const wgsl = (strings: TemplateStringsArray, ...values: readonly (string | number)[]) => strings.reduce((source, s, i) => source + String(values[i - 1]) + s);
