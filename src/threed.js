// 3D preview: extrude selected (or all) shapes with Three.js, orbit + lights,
// export as PNG render or as a flattened vector projection (SVGRenderer output
// re-imported as shapes).

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SVGRenderer } from "three/examples/jsm/renderers/SVGRenderer.js";
import { isGradient, sortedStops } from "./gradients.js";

export const MATERIALS = {
  matte: { roughness: 0.85, metalness: 0.0 },
  glossy: { roughness: 0.15, metalness: 0.1 },
  metal: { roughness: 0.35, metalness: 1.0 },
};

function fillColor(fill) {
  if (typeof fill === "string") {
    return fill;
  }
  if (isGradient(fill)) {
    const stops = sortedStops(fill.stops);
    return stops[Math.floor(stops.length / 2)].color;
  }
  return "#4a7dff";
}

function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function pointInPolygon(pt, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function firstOnCurve(points) {
  return points.find((p) => !p.type) || points[0];
}

// Serialize one contour onto a THREE.Path, closing wrap-around off-curves.
function emitContour(path, contour) {
  const points = [...contour.points];
  let closing = null;
  if (contour.isClosed && points.length > 1) {
    const last = points[points.length - 1];
    const beforeLast = points[points.length - 2];
    if (last.type === "cubic" && beforeLast.type === "cubic") {
      points.pop();
      points.pop();
      closing = (p) =>
        p.bezierCurveTo(beforeLast.x, beforeLast.y, last.x, last.y, points[0].x, points[0].y);
    } else if (last.type === "quad") {
      points.pop();
      closing = (p) => p.quadraticCurveTo(last.x, last.y, points[0].x, points[0].y);
    }
  }
  path.moveTo(points[0].x, points[0].y);
  let i = 1;
  while (i < points.length) {
    const p = points[i];
    if (p.type === "cubic") {
      path.bezierCurveTo(p.x, p.y, points[i + 1].x, points[i + 1].y, points[i + 2].x, points[i + 2].y);
      i += 3;
    } else if (p.type === "quad") {
      path.quadraticCurveTo(p.x, p.y, points[i + 1].x, points[i + 1].y);
      i += 2;
    } else {
      path.lineTo(p.x, p.y);
      i += 1;
    }
  }
  if (closing) {
    closing(path);
  }
  if (contour.isClosed) {
    path.closePath();
  }
}

// Group a shape's contours into THREE.Shapes with holes (even nesting depth =
// outer, odd = hole of nearest outer ancestor).
function shapeToThreeShapes(shape) {
  const contours = shape.path
    .unpackedContours()
    .filter((c) => c.points.length > 2)
    .map((c) => ({
      contour: c,
      area: Math.abs(signedArea(c.points)),
      anchor: firstOnCurve(c.points),
      parents: [],
    }));
  for (const a of contours) {
    for (const b of contours) {
      if (a !== b && b.area > a.area && pointInPolygon(a.anchor, b.contour.points)) {
        a.parents.push(b);
      }
    }
  }
  const shapes = [];
  const outers = [];
  for (const c of contours) {
    c.parents.sort((p, q) => p.area - q.area);
    if (c.parents.length % 2 === 0) {
      c.three = new THREE.Shape();
      emitContour(c.three, c.contour);
      shapes.push(c.three);
      outers.push(c);
    }
  }
  for (const c of contours) {
    if (c.parents.length % 2 === 1) {
      const hole = new THREE.Path();
      emitContour(hole, c.contour);
      c.parents[0].three.holes.push(hole);
    }
  }
  return shapes;
}

export class ThreeDView {
  constructor(container, shapes) {
    this.container = container;
    this.sourceShapes = shapes;
    this.depth = 40;
    this.materialType = "matte";
    this.azimuth = 45;
    this.elevation = 45;
    this._disposed = false;

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setSize(width, height);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#f4f4f6");
    this.camera = new THREE.PerspectiveCamera(40, width / height, 1, 100000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x445, 0.9);
    this.scene.add(this.hemiLight);
    this.dirLight = new THREE.DirectionalLight(0xffffff, 2.2);
    this.scene.add(this.dirLight);

    this.meshGroup = new THREE.Group();
    this.scene.add(this.meshGroup);
    this.rebuild();
    this.setLight(this.azimuth, this.elevation);

    const animate = () => {
      if (this._disposed) {
        return;
      }
      this._raf = requestAnimationFrame(animate);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  rebuild() {
    for (const child of [...this.meshGroup.children]) {
      child.geometry.dispose();
      child.material.dispose();
      this.meshGroup.remove(child);
    }
    const materialDef = MATERIALS[this.materialType] || MATERIALS.matte;
    for (const shape of this.sourceShapes) {
      const threeShapes = shapeToThreeShapes(shape);
      if (!threeShapes.length) {
        continue;
      }
      const geometry = new THREE.ExtrudeGeometry(threeShapes, {
        depth: this.depth,
        bevelEnabled: false,
        curveSegments: 6,
      });
      geometry.translate(shape.x, shape.y, 0);
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(fillColor(shape.fill)),
        roughness: materialDef.roughness,
        metalness: materialDef.metalness,
      });
      this.meshGroup.add(new THREE.Mesh(geometry, material));
    }
    this.fitCamera();
  }

  fitCamera() {
    const box = new THREE.Box3().setFromObject(this.meshGroup);
    if (box.isEmpty()) {
      return;
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 1);
    this.controls.target.copy(center);
    this.camera.position.set(
      center.x + radius * 0.7,
      center.y + radius * 0.55,
      center.z + radius * 2.2
    );
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setLight(azimuthDeg, elevationDeg) {
    this.azimuth = azimuthDeg;
    this.elevation = elevationDeg;
    const az = (azimuthDeg * Math.PI) / 180;
    const el = (elevationDeg * Math.PI) / 180;
    const r = 1000;
    this.dirLight.position.set(
      r * Math.cos(el) * Math.cos(az),
      r * Math.sin(el),
      r * Math.cos(el) * Math.sin(az)
    );
  }

  renderPNG() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }

  // Flatten the current view to SVG paths (solid colors) for re-import.
  renderSVG() {
    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 600;
    const swapped = [];
    for (const mesh of this.meshGroup.children) {
      swapped.push([mesh, mesh.material]);
      mesh.material = new THREE.MeshBasicMaterial({ color: mesh.material.color.clone() });
    }
    const svgRenderer = new SVGRenderer();
    svgRenderer.setSize(width, height);
    svgRenderer.render(this.scene, this.camera);
    for (const [mesh, material] of swapped) {
      mesh.material.dispose();
      mesh.material = material;
    }
    const svg = new XMLSerializer().serializeToString(svgRenderer.domElement);
    return svg;
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
