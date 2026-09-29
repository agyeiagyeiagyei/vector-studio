import esbuild from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

const aliasFontraCore = {
  name: "alias-fontra-core",
  setup(build) {
    build.onResolve({ filter: /^@fontra\/core\// }, (args) => {
      const rest = args.path.slice("@fontra/core/".length);
      return { path: path.join(root, "vendor/fontra/core", rest) };
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(root, "src/app.js")],
  bundle: true,
  format: "esm",
  outfile: path.join(root, "dist/bundle.js"),
  plugins: [aliasFontraCore],
  logLevel: "info",
});

fs.copyFileSync(path.join(root, "index.html"), path.join(root, "dist/index.html"));
fs.cpSync(path.join(root, "assets"), path.join(root, "dist/assets"), { recursive: true });
