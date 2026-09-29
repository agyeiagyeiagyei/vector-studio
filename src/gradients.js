// Gradient fills. A shape's `fill` is either null, a CSS color string, or a
// gradient object. Gradient coordinates are fractions of the shape's control
// bounds (0..1), so gradients travel with the shape.
//
//   { type: "linear", angle: 90, stops: [{ offset, color }] }   // 0° = +x
//   { type: "radial", r: 0.5, stops: [{ offset, color }] }      // r: fraction of bbox half-diagonal

export function isGradient(fill) {
  return fill !== null && typeof fill === "object";
}

export function defaultGradient(type, fromColor = "#4a7dff", toColor = "#b04aff") {
  return {
    type,
    ...(type === "linear" ? { angle: 0 } : { r: 0.5 }),
    stops: [
      { offset: 0, color: fromColor },
      { offset: 1, color: toColor },
    ],
  };
}

function linearEndpoints(angleDeg, w, h) {
  const t = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(t);
  const dy = Math.sin(t);
  // half-length covering the bbox along (dx, dy): max projection of the box
  const len = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
  return { dx, dy, len };
}

// Canvas gradient for drawing, in shape-local coordinates.
export function makeFillStyle(context, fill, bounds) {
  if (!isGradient(fill)) {
    return fill || null;
  }
  const w = bounds.xMax - bounds.xMin;
  const h = bounds.yMax - bounds.yMin;
  const cx = (bounds.xMin + bounds.xMax) / 2;
  const cy = (bounds.yMin + bounds.yMax) / 2;
  let gradient;
  if (fill.type === "linear") {
    const { dx, dy, len } = linearEndpoints(fill.angle ?? 0, w, h);
    gradient = context.createLinearGradient(cx - dx * len, cy - dy * len, cx + dx * len, cy + dy * len);
  } else {
    const radius = (fill.r ?? 0.5) * Math.hypot(w, h) * 0.5;
    gradient = context.createRadialGradient(cx, cy, 0, cx, cy, Math.max(radius, 0.001));
  }
  for (const stop of sortedStops(fill)) {
    gradient.addColorStop(stop.offset, stop.color);
  }
  return gradient;
}

export function sortedStops(fill) {
  return [...(fill.stops || [])].sort((a, b) => a.offset - b.offset);
}

// CSS approximation for swatches / the stop editor bar.
export function fillToCSS(fill) {
  if (!isGradient(fill)) {
    return fill || "transparent";
  }
  const stops = sortedStops(fill)
    .map((s) => `${s.color} ${Math.round(s.offset * 100)}%`)
    .join(", ");
  if (fill.type === "linear") {
    // CSS 0deg = to top, clockwise; our 0° = +x in y-up space
    return `linear-gradient(${90 - (fill.angle ?? 0)}deg, ${stops})`;
  }
  return `radial-gradient(circle, ${stops})`;
}

// --- SVG ---

let nextGradientId = 1;

function fmtPct(n) {
  return `${Math.round(n * 1000) / 10}%`;
}

// The export wraps all paths in a y-flipping group, so y fractions are
// emitted inverted to land right-side up.
export function gradientToSVGDef(fill, id) {
  const stops = sortedStops(fill)
    .map((s) => `<stop offset="${fmtPct(s.offset)}" stop-color="${s.color}"/>`)
    .join("");
  if (fill.type === "linear") {
    const { dx, dy, len } = linearEndpoints(fill.angle ?? 0, 1, 1);
    const x1 = 0.5 - dx * len;
    const y1 = 0.5 - dy * len;
    const x2 = 0.5 + dx * len;
    const y2 = 0.5 + dy * len;
    return (
      `<linearGradient id="${id}" x1="${fmtPct(x1)}" y1="${fmtPct(1 - y1)}" ` +
      `x2="${fmtPct(x2)}" y2="${fmtPct(1 - y2)}">${stops}</linearGradient>`
    );
  }
  // objectBoundingBox radial renders elliptical on non-square bboxes; accepted
  // divergence from the circular canvas rendering.
  return `<radialGradient id="${id}" cx="50%" cy="50%" r="${fmtPct(fill.r ?? 0.5)}">${stops}</radialGradient>`;
}

export function allocGradientId() {
  return `vs-g${nextGradientId++}`;
}

function parseStops(gradEl) {
  const stops = [];
  for (const stop of gradEl.querySelectorAll("stop")) {
    const offsetRaw = stop.getAttribute("offset") ?? "0";
    const offset = offsetRaw.trim().endsWith("%")
      ? parseFloat(offsetRaw) / 100
      : parseFloat(offsetRaw);
    let color = stop.getAttribute("stop-color");
    if (!color) {
      const m = (stop.getAttribute("style") || "").match(/stop-color\s*:\s*([^;]+)/);
      color = m && m[1].trim();
    }
    if (color && isFinite(offset)) {
      stops.push({ offset: Math.min(1, Math.max(0, offset)), color });
    }
  }
  return stops;
}

function parseFraction(attr, fallback) {
  if (attr === null) {
    return fallback;
  }
  const v = attr.trim();
  if (v.endsWith("%")) {
    return parseFloat(v) / 100;
  }
  const n = parseFloat(v);
  return isFinite(n) ? n : fallback;
}

// Resolve fill="url(#id)" against the parsed SVG document. bbox is the path's
// local control bounds, used to convert userSpaceOnUse coordinates. Returns a
// gradient object (y-flipped back into our y-up space) or null.
export function resolveGradientRef(svgDoc, fillAttr, bbox) {
  const m = /^url\(\s*#([^\)\s]+)\s*\)$/.exec(fillAttr || "");
  if (!m) {
    return null;
  }
  const gradEl = svgDoc.getElementById(m[1]);
  if (!gradEl) {
    return null;
  }
  const stops = parseStops(gradEl);
  if (!stops.length) {
    return null;
  }
  const userSpace = gradEl.getAttribute("gradientUnits") === "userSpaceOnUse";
  // Convert userSpaceOnUse coords (absolute, y-down) into bbox fractions.
  const w = bbox ? bbox.xMax - bbox.xMin : 0;
  const h = bbox ? bbox.yMax - bbox.yMin : 0;
  const frac = (attr, fallback, axis) => {
    if (!userSpace) {
      return parseFraction(attr, fallback);
    }
    if (attr === null || !bbox || !(axis === "x" ? w : h)) {
      return fallback;
    }
    const v = parseFloat(attr);
    // imported paths are y-flipped out of SVG space; userSpace y must be too
    const ours = axis === "y" ? -v : v;
    const min = axis === "x" ? bbox.xMin : bbox.yMin;
    return (ours - min) / (axis === "x" ? w : h);
  };
  const flip = (y) => 1 - y;

  if (gradEl.tagName === "linearGradient") {
    const x1 = frac(gradEl.getAttribute("x1"), 0, "x");
    const y1 = flip(frac(gradEl.getAttribute("y1"), 0, "y"));
    const x2 = frac(gradEl.getAttribute("x2"), 1, "x");
    const y2 = flip(frac(gradEl.getAttribute("y2"), 0, "y"));
    const dx = x2 - x1;
    const dy = y2 - y1;
    const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    return { type: "linear", angle, stops };
  }
  if (gradEl.tagName === "radialGradient") {
    const r = frac(gradEl.getAttribute("r"), 0.5, "x");
    return { type: "radial", r: Math.min(1.5, Math.max(0.02, r)), stops };
  }
  return null;
}
