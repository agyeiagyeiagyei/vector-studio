# Vector Studio

A browser-based vector editor: pen, shapes, knife, node editing, solid/linear/radial
gradient fills, SVG import/export, undo/redo. Built on a vendored subset of
[Fontra](https://github.com/fontra/fontra)'s editor core (path model, canvas controller,
editing tools), adapted from font glyphs to general shapes.

**Live:** https://agyeiagyeiagyei.github.io/vector-studio/

## Develop

```
npm ci
node build.mjs     # bundles src/ -> dist/ with esbuild
```

Serve `dist/` statically. No framework, no runtime deps beyond the bundle.

## License

GPL-3.0 (derivative of Fontra, which is GPL-3.0). See LICENSE.
