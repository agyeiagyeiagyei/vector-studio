// Text objects: a Shape with shape.text = { string, font, size, variations }.
// The shape's path is *derived* from the text via fontkit layout and rebuilt
// whenever the text properties change. "Convert to outlines" explodes a text
// shape into one plain shape per glyph.

import * as fontkit from "fontkit";
import { VarPackedPath } from "@fontra/core/var-path.js";

export const DEFAULT_FONT_ID = "roboto-flex";

export class FontManager {
  constructor() {
    this.fonts = new Map(); // id -> { id, name, font, axes: [{tag,min,max,default}] }
    this._variationCache = new Map(); // id+JSON(coords) -> variation font
    this._readyPromise = null;
  }

  async ensureDefaultFont() {
    if (!this._readyPromise) {
      this._readyPromise = this.loadFromURL(
        "./assets/RobotoFlex.ttf",
        DEFAULT_FONT_ID,
        "Roboto Flex"
      );
    }
    return this._readyPromise;
  }

  async loadFromURL(url, id, name) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`font fetch failed: ${response.status}`);
    }
    return this.loadFromBuffer(await response.arrayBuffer(), id, name);
  }

  loadFromBuffer(buffer, id, name) {
    let font = fontkit.create(new Uint8Array(buffer));
    if (font.fonts) {
      font = font.fonts[0]; // collection: take first
    }
    const axes = font.variationAxes
      ? Object.entries(font.variationAxes).map(([tag, a]) => ({
          tag,
          min: a.min,
          max: a.max,
          default: a.default,
        }))
      : [];
    const entry = {
      id,
      name: name || font.familyName || id,
      font,
      axes,
      unitsPerEm: font.unitsPerEm,
    };
    this.fonts.set(id, entry);
    return entry;
  }

  get(id) {
    return this.fonts.get(id);
  }

  // Font instance with variation coordinates applied (cached).
  variationFont(id, variations = {}) {
    const key = id + JSON.stringify(variations);
    let vf = this._variationCache.get(key);
    if (!vf) {
      const entry = this.fonts.get(id);
      if (!entry) {
        return undefined;
      }
      vf = entry.axes.length ? entry.font.getVariation(variations) : entry.font;
      this._variationCache.set(key, vf);
    }
    return vf;
  }
}

function glyphPathToContours(glyphPath) {
  const contours = [];
  let current = null;
  for (const cmd of glyphPath.commands) {
    const a = cmd.args;
    if (cmd.command === "moveTo") {
      current = { points: [{ x: a[0], y: a[1] }], isClosed: false };
      contours.push(current);
    } else if (cmd.command === "lineTo") {
      current?.points.push({ x: a[0], y: a[1] });
    } else if (cmd.command === "bezierCurveTo") {
      current?.points.push(
        { x: a[0], y: a[1], type: "cubic" },
        { x: a[2], y: a[3], type: "cubic" },
        { x: a[4], y: a[5] }
      );
    } else if (cmd.command === "quadraticCurveTo") {
      current?.points.push({ x: a[0], y: a[1], type: "quad" }, { x: a[2], y: a[3] });
    } else if (cmd.command === "closePath") {
      if (current) {
        current.isClosed = true;
        const pts = current.points;
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (
          pts.length > 1 &&
          Math.abs(last.x - first.x) < 1e-9 &&
          Math.abs(last.y - first.y) < 1e-9 &&
          !last.type
        ) {
          pts.pop();
        }
      }
      current = null;
    }
  }
  return contours;
}

function translateContours(contours, dx, dy) {
  for (const contour of contours) {
    for (const p of contour.points) {
      p.x += dx;
      p.y += dy;
    }
  }
  return contours;
}

// One laid-out glyph: contours in shape-local units (scaled and pen-positioned).
function layoutGlyphs(font, text, size) {
  const run = font.layout(text);
  const scale = size / font.unitsPerEm;
  const laidOut = [];
  let penX = 0;
  for (let i = 0; i < run.glyphs.length; i++) {
    const glyph = run.glyphs[i];
    const pos = run.positions[i];
    const contours = glyphPathToContours(glyph.path);
    // position in font units, then scale once
    translateContours(contours, penX + pos.xOffset, pos.yOffset);
    for (const contour of contours) {
      for (const p of contour.points) {
        p.x *= scale;
        p.y *= scale;
      }
    }
    laidOut.push({ glyph, contours, advance: pos.xAdvance * scale });
    penX += pos.xAdvance;
  }
  return laidOut;
}

// Rebuild a text shape's derived path from its text properties.
export function relayoutTextShape(fonts, shape) {
  const t = shape.text;
  const font = fonts.variationFont(t.font, t.variations);
  if (!font) {
    return;
  }
  const path = new VarPackedPath();
  for (const { contours } of layoutGlyphs(font, t.string, t.size)) {
    for (const contour of contours) {
      if (contour.points.length) {
        path.appendPath(VarPackedPath.fromUnpackedContours([contour]));
      }
    }
  }
  shape.layerGlyph.path = path;
}

// Explode a text shape into one plain Shape per glyph (in scene coords via
// the text shape's x/y). Returns [] if not a text shape.
export function textShapeToOutlines(fonts, shape, ShapeClass) {
  const t = shape.text;
  if (!t) {
    return [];
  }
  const font = fonts.variationFont(t.font, t.variations);
  if (!font) {
    return [];
  }
  const result = [];
  const laidOut = layoutGlyphs(font, t.string, t.size);
  for (let i = 0; i < laidOut.length; i++) {
    const { contours, glyph } = laidOut[i];
    if (!contours.some((c) => c.points.length)) {
      continue; // whitespace glyph
    }
    const letter = new ShapeClass(`${t.string} · ${glyph.codePoints?.length ? String.fromCodePoint(...glyph.codePoints) : i}`);
    letter.layerGlyph.path = VarPackedPath.fromUnpackedContours(contours);
    letter.x = shape.x;
    letter.y = shape.y;
    letter.fill = shape.fill;
    letter.stroke = shape.stroke;
    letter.strokeWidth = shape.strokeWidth;
    result.push(letter);
  }
  return result;
}
