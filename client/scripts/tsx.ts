/**
 * The client's .tsx files, which Vite compiles for Solid, loadable in a
 * script: the colours and tables live beside their components, and here
 * nothing is rendered, so any JSX runtime will do. Import this first, then
 * the client's code dynamically, after it.
 */
Bun.plugin({
  name: "solid-jsx",
  setup(build) {
    const tsx = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "solid-js/h" } } });
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({ contents: tsx.transformSync(await Bun.file(path).text()), loader: "js" }));
  },
});
