import { VarPackedPath } from "@fontra/core/var-path.js";
import { allocGradientId, gradientToSVGDef, isGradient, resolveGradientRef } from "./gradients.js";

// SVG is y-down, our scene is y-up. Export wraps paths in a flipping group;
// import flips coordinates back.

export function pathToSVGPathData(path) {
  const parts = [];
  for (const contour of path.unpackedContours()) {
    const points = [...contour.points];
    if (!points.length) {
      continue;
    }
    // TrueType outlines may end a closed contour with off-curve points whose
    // segment wraps to the first point; serialize that segment explicitly.
    let closingSegment = null;
    if (contour.isClosed && points.length > 1) {
      const last = points[points.length - 1];
      const beforeLast = points[points.length - 2];
      if (last.type === "cubic" && beforeLast.type === "cubic") {
        points.pop();
        points.pop();
        closingSegment =
          `C${fmt(beforeLast.x)} ${fmt(beforeLast.y)} ${fmt(last.x)} ${fmt(last.y)} ` +
          `${fmt(points[0].x)} ${fmt(points[0].y)}`;
      } else if (last.type === "quad") {
        points.pop();
        closingSegment = `Q${fmt(last.x)} ${fmt(last.y)} ${fmt(points[0].x)} ${fmt(points[0].y)}`;
      }
    }
    parts.push(`M${fmt(points[0].x)} ${fmt(points[0].y)}`);
    let i = 1;
    while (i < points.length) {
      const p = points[i];
      if (p.type === "cubic") {
        const c1 = points[i];
        const c2 = points[i + 1];
        const p3 = points[i + 2];
        parts.push(
          `C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(p3.x)} ${fmt(p3.y)}`
        );
        i += 3;
      } else if (p.type === "quad") {
        const c1 = points[i];
        const p2 = points[i + 1];
        parts.push(`Q${fmt(c1.x)} ${fmt(c1.y)} ${fmt(p2.x)} ${fmt(p2.y)}`);
        i += 2;
      } else {
        parts.push(`L${fmt(p.x)} ${fmt(p.y)}`);
        i += 1;
      }
    }
    if (closingSegment) {
      parts.push(closingSegment);
    }
    if (contour.isClosed) {
      parts.push("Z");
    }
  }
  return parts.join(" ");
}

function fmt(n) {
  return Math.round(n * 100) / 100;
}

function docBounds(doc) {
  let bounds;
  for (const shape of doc.shapes) {
    const b = shape.path.getControlBounds();
    if (!b) {
      continue;
    }
    const sb = {
      xMin: b.xMin + shape.x,
      yMin: b.yMin + shape.y,
      xMax: b.xMax + shape.x,
      yMax: b.yMax + shape.y,
    };
    bounds = bounds
      ? {
          xMin: Math.min(bounds.xMin, sb.xMin),
          yMin: Math.min(bounds.yMin, sb.yMin),
          xMax: Math.max(bounds.xMax, sb.xMax),
          yMax: Math.max(bounds.yMax, sb.yMax),
        }
      : sb;
  }
  return bounds;
}

export function exportSVG(doc, artboard = undefined) {
  // With an active artboard the export crops to it; otherwise all shapes + margin.
  const margin = artboard ? 0 : 20;
  const bounds = artboard
    ? {
        xMin: artboard.x,
        yMin: artboard.y,
        xMax: artboard.x + artboard.width,
        yMax: artboard.y + artboard.height,
      }
    : docBounds(doc) || { xMin: 0, yMin: 0, xMax: 800, yMax: 600 };
  const x0 = bounds.xMin - margin;
  const y0 = bounds.yMin - margin;
  const w = bounds.xMax - bounds.xMin + 2 * margin;
  const h = bounds.yMax - bounds.yMin + 2 * margin;

  const defs = [];
  const fillRef = new Map(); // shape -> gradient id
  for (const shape of doc.shapes) {
    if (isGradient(shape.fill)) {
      const id = allocGradientId();
      fillRef.set(shape, id);
      defs.push(gradientToSVGDef(shape.fill, id));
    }
  }

  const paths = doc.shapes
    .map((shape) => {
      if (!shape.path.numPoints) {
        return "";
      }
      const d = pathToSVGPathData(shape.path);
      const fill = fillRef.has(shape) ? `url(#${fillRef.get(shape)})` : shape.fill || "none";
      const strokeAttrs =
        shape.stroke && shape.strokeWidth > 0
          ? ` stroke="${shape.stroke}" stroke-width="${shape.strokeWidth}"`
          : "";
      return `<path d="${d}" fill="${fill}"${strokeAttrs} transform="translate(${fmt(shape.x)} ${fmt(shape.y)})"/>`;
    })
    .filter(Boolean)
    .join("\n    ");

  const defsBlock = defs.length ? `  <defs>\n    ${defs.join("\n    ")}\n  </defs>\n` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(w)} ${fmt(h)}" width="${fmt(w)}" height="${fmt(h)}">
${defsBlock}  <g transform="translate(${fmt(-x0)} ${fmt(y0 + h)}) scale(1 -1)">
    ${paths}
  </g>
</svg>
`;
}

// --- Import ---

const COMMAND_RE = /([MmLlHhVvCcSsQqTtZz])([^MmLlHhVvCcSsQqTtZz]*)/g;

export function parseSVGPathData(d) {
  // Returns unpacked contours in SVG (y-down) coordinates.
  const contours = [];
  let match;
  let cx = 0,
    cy = 0,
    startX = 0,
    startY = 0;
  let current = null;
  let prevCubicControl = null;
  let prevQuadControl = null;

  const num = (s, i) => parseFloat(s[i]);

  COMMAND_RE.lastIndex = 0;
  while ((match = COMMAND_RE.exec(d)) !== null) {
    const cmd = match[1];
    const args = match[2]
      .trim()
      .split(/[\s,]+/)
      .filter((s) => s.length)
      .map(parseFloat);
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    const ax = (x) => (rel ? cx + x : x);
    const ay = (y) => (rel ? cy + y : y);

    if (C === "M") {
      for (let i = 0; i + 1 < args.length || i === 0; i += 2) {
        if (i === 0) {
          current = { points: [{ x: ax(args[0]), y: ay(args[1]) }], isClosed: false };
          contours.push(current);
          cx = ax(args[0]);
          cy = ay(args[1]);
          startX = cx;
          startY = cy;
        } else {
          if (i + 1 >= args.length) {
            break;
          }
          cx = ax(args[i]);
          cy = ay(args[i + 1]);
          current.points.push({ x: cx, y: cy });
        }
        prevCubicControl = prevQuadControl = null;
      }
    } else if (C === "L") {
      for (let i = 0; i + 1 < args.length; i += 2) {
        cx = ax(args[i]);
        cy = ay(args[i + 1]);
        current?.points.push({ x: cx, y: cy });
      }
      prevCubicControl = prevQuadControl = null;
    } else if (C === "H") {
      for (const x of args) {
        cx = rel ? cx + x : x;
        current?.points.push({ x: cx, y: cy });
      }
      prevCubicControl = prevQuadControl = null;
    } else if (C === "V") {
      for (const y of args) {
        cy = rel ? cy + y : y;
        current?.points.push({ x: cx, y: cy });
      }
      prevCubicControl = prevQuadControl = null;
    } else if (C === "C") {
      for (let i = 0; i + 5 < args.length; i += 6) {
        const c1 = { x: ax(args[i]), y: ay(args[i + 1]), type: "cubic" };
        const c2 = { x: ax(args[i + 2]), y: ay(args[i + 3]), type: "cubic" };
        cx = ax(args[i + 4]);
        cy = ay(args[i + 5]);
        current?.points.push(c1, c2, { x: cx, y: cy });
        prevCubicControl = c2;
        prevQuadControl = null;
      }
    } else if (C === "S") {
      for (let i = 0; i + 3 < args.length; i += 4) {
        const c1 = prevCubicControl
          ? { x: 2 * cx - prevCubicControl.x, y: 2 * cy - prevCubicControl.y, type: "cubic" }
          : { x: cx, y: cy, type: "cubic" };
        const c2 = { x: ax(args[i]), y: ay(args[i + 1]), type: "cubic" };
        cx = ax(args[i + 2]);
        cy = ay(args[i + 3]);
        current?.points.push(c1, c2, { x: cx, y: cy });
        prevCubicControl = c2;
        prevQuadControl = null;
      }
    } else if (C === "Q") {
      for (let i = 0; i + 3 < args.length; i += 4) {
        const c = { x: ax(args[i]), y: ay(args[i + 1]), type: "quad" };
        cx = ax(args[i + 2]);
        cy = ay(args[i + 3]);
        current?.points.push(c, { x: cx, y: cy });
        prevQuadControl = c;
        prevCubicControl = null;
      }
    } else if (C === "T") {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const c = prevQuadControl
          ? { x: 2 * cx - prevQuadControl.x, y: 2 * cy - prevQuadControl.y, type: "quad" }
          : { x: cx, y: cy, type: "quad" };
        cx = ax(args[i]);
        cy = ay(args[i + 1]);
        current?.points.push(c, { x: cx, y: cy });
        prevQuadControl = c;
        prevCubicControl = null;
      }
    } else if (C === "Z") {
      if (current) {
        current.isClosed = true;
        // remove duplicate closing point if present
        const pts = current.points;
        const last = pts[pts.length - 1];
        if (
          pts.length > 1 &&
          Math.abs(last.x - startX) < 1e-9 &&
          Math.abs(last.y - startY) < 1e-9 &&
          !last.type
        ) {
          pts.pop();
        }
      }
      cx = startX;
      cy = startY;
      current = null;
      prevCubicControl = prevQuadControl = null;
    }
  }
  return contours;
}

function flipContours(contours) {
  return contours.map((contour) => ({
    isClosed: contour.isClosed,
    points: contour.points.map((p) => ({
      x: p.x,
      y: -p.y,
      ...(p.type ? { type: p.type } : {}),
      ...(p.smooth ? { smooth: p.smooth } : {}),
    })),
  }));
}

export function importSVG(doc, svgText, ShapeClass) {
  const parser = new DOMParser();
  const svgDoc = parser.parseFromString(svgText, "image/svg+xml");
  const imported = [];
  for (const pathEl of svgDoc.querySelectorAll("path")) {
    const d = pathEl.getAttribute("d");
    if (!d) {
      continue;
    }
    const contours = flipContours(parseSVGPathData(d));
    if (!contours.length) {
      continue;
    }
    const style = parseStyleAttr(pathEl.getAttribute("style"));
    const shape = new ShapeClass(pathEl.getAttribute("id") || undefined);
    shape.layerGlyph.path = VarPackedPath.fromUnpackedContours(contours);
    const fill = pathEl.getAttribute("fill") ?? style.fill;
    if (fill && fill.startsWith("url(")) {
      const gradient = resolveGradientRef(svgDoc, fill, shape.path.getControlBounds());
      shape.fill = gradient || null;
    } else if (fill && fill !== "none") {
      shape.fill = cssColorToHex(fill) || fill;
    } else if (fill === "none") {
      shape.fill = null;
    }
    const stroke = pathEl.getAttribute("stroke") ?? style.stroke;
    if (stroke && stroke !== "none") {
      shape.stroke = cssColorToHex(stroke) || stroke;
      shape.strokeWidth =
        parseFloat(pathEl.getAttribute("stroke-width") ?? style["stroke-width"] ?? "1") || 1;
    }
    doc.addShape(shape);
    imported.push(shape);
  }
  return imported;
}

function parseStyleAttr(styleAttr) {
  const style = {};
  for (const decl of (styleAttr || "").split(";")) {
    const idx = decl.indexOf(":");
    if (idx > 0) {
      style[decl.slice(0, idx).trim()] = decl.slice(idx + 1).trim();
    }
  }
  return style;
}

function cssColorToHex(color) {
  const m = color.match(/^rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*\)$/);
  if (!m) {
    return null;
  }
  return "#" + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, "0")).join("");
}
