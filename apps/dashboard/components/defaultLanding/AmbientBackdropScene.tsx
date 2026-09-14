import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * [director ask: the light-mode landing page is "too bland and blank canvas"]
 *
 * The animated half of `AmbientBackdrop.tsx`. Reached ONLY through that file's
 * `next/dynamic(..., { ssr: false })` import — never imported directly by a page,
 * and never by anything under `pages/teams/**`, `pages/settings/**` or any other
 * authenticated route, same containment rule `WebhookFlowScene.tsx` follows. It also
 * shares `three` with that scene, so on `/` this is a second component in an already-
 * loaded chunk, not a second copy of the library.
 *
 * WHAT IT DRAWS: a still mesh of ~24 nodes wired to their nearest neighbours, with a
 * handful of bright pulses crawling along those wires — an endpoint graph with
 * traffic moving through it, which is literally what Relay sits in the middle of. No
 * counters, no labels, no numbers render onto the canvas: like the hero scene, it is
 * pure motion, so it cannot imply a request volume or customer count the honesty bar
 * (RELAY-64) would object to.
 *
 * WHY THE NODES DON'T MOVE and only the pulses do: a drifting mesh behind body copy
 * is the kind of movement the eye keeps chasing back to. Fixed topology + moving
 * traffic reads as "a network that is up", which is the actual product claim, and it
 * also means the ~40-edge line geometry is written ONCE at setup and never touched
 * again — the per-frame write is 10 pulses × 3 floats and nothing else.
 *
 * PERF: `WebGLRenderer` with `alpha: true` and `powerPreference: "low-power"` (a
 * background wash has no business waking a discrete GPU), DPR capped at 1.5 rather
 * than the hero's 2 — this is out-of-focus ambience and nobody will ever inspect an
 * edge of it. The rAF loop is additionally capped to ~30fps: every frame past that is
 * battery spent on something the reader is deliberately not looking at. It stops
 * rendering whenever the tab is backgrounded and whenever an `IntersectionObserver`
 * says the layer is not on screen — for a viewport-fixed layer that second signal is
 * not about scrolling but about `display: none`, where an observer correctly reports
 * non-intersecting and a naive rAF loop would keep rendering into nothing. The
 * backgrounded-tab check is read straight off `document.hidden` inside the frame
 * rather than latched from a `visibilitychange` listener: `running = !document.hidden
 * && running` (the shape `WebhookFlowScene.tsx` uses) can only ever drive the flag
 * false, so a tab that is backgrounded and then restored never resumes.
 *
 * THEME: the palette is re-read from the `.dark` class on `<html>` — the switch
 * `lib/theme.ts`'s `applyTheme` actually toggles — and a `MutationObserver` on that
 * attribute repaints it when the user flips the toggle, so the mesh does not stay a
 * light-mode wash on a dark page. Light values are deliberately much weaker than dark
 * ones: the same alpha that reads as a whisper on #0d0f12 reads as dirt on #f7f8fa.
 */

/** Fixed topology, so the layout is identical on every load and every reload —
 *  a `Math.random()` field would make any visual regression check meaningless. */
const FIELD_HALF_W = 1.6;
const FIELD_HALF_H = 1.0;
/* 9×6 and not something coarser for a readability reason, measured on screenshots
 * rather than guessed: the landing section cards are translucent
 * (`bg-landing-surface/40`-family), so backdrop edges DO show through body copy. On a
 * coarse grid each edge is ~270px long and reads as a stroke ruled across a
 * paragraph. At this density an edge is ~160px, which reads as texture instead —
 * same total ink, no single line long enough to look deliberate over a sentence. */
const GRID_COLS = 9;
const GRID_ROWS = 6;
const NEIGHBOURS_PER_NODE = 2;
const PULSE_COUNT = 16;
const TARGET_FPS = 30;

/** Tiny deterministic LCG — enough jitter to stop the grid reading as a grid. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Palette = {
  edge: number;
  edgeOpacity: number;
  node: number;
  nodeOpacity: number;
  pulse: number;
  pulseOpacity: number;
};

const DARK: Palette = {
  edge: 0x2dd4bf,
  edgeOpacity: 0.11,
  node: 0x2dd4bf,
  nodeOpacity: 0.28,
  pulse: 0x5eead4,
  pulseOpacity: 0.6,
};

const LIGHT: Palette = {
  edge: 0x0d9488,
  edgeOpacity: 0.09,
  node: 0x0d9488,
  nodeOpacity: 0.2,
  pulse: 0x0f766e,
  pulseOpacity: 0.4,
};

export default function AmbientBackdropScene() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: 'low-power',
      });
    } catch {
      // No WebGL. The static CSS wash `AmbientBackdrop` already painted is still
      // there underneath and is a complete answer to the "blank canvas" complaint
      // on its own — nothing to clean up, nothing thrown further.
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 5;

    // ── Topology (built once) ───────────────────────────────────────────────
    const rand = seeded(0x5e11a7);
    const nodes: THREE.Vector2[] = [];
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const cellW = (FIELD_HALF_W * 2) / GRID_COLS;
        const cellH = (FIELD_HALF_H * 2) / GRID_ROWS;
        nodes.push(
          new THREE.Vector2(
            -FIELD_HALF_W + (col + 0.15 + rand() * 0.7) * cellW,
            -FIELD_HALF_H + (row + 0.15 + rand() * 0.7) * cellH
          )
        );
      }
    }

    // Each node wires to its N nearest neighbours; the Set dedupes the pairs both
    // ends of an edge would otherwise produce.
    const edgeKeys = new Set<string>();
    const edges: Array<[number, number]> = [];
    for (let i = 0; i < nodes.length; i++) {
      const byDistance = nodes
        .map((n, j) => ({ j, d: nodes[i].distanceTo(n) }))
        .filter((e) => e.j !== i)
        .sort((a, b) => a.d - b.d)
        .slice(0, NEIGHBOURS_PER_NODE);
      for (const { j } of byDistance) {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push([i, j]);
      }
    }

    const edgePositions = new Float32Array(edges.length * 6);
    edges.forEach(([a, b], i) => {
      edgePositions.set(
        [nodes[a].x, nodes[a].y, 0, nodes[b].x, nodes[b].y, 0],
        i * 6
      );
    });
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(edgePositions, 3)
    );
    const edgeMaterial = new THREE.LineBasicMaterial({ transparent: true });
    scene.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));

    const nodePositions = new Float32Array(nodes.length * 3);
    nodes.forEach((n, i) => nodePositions.set([n.x, n.y, 0], i * 3));
    const nodeGeometry = new THREE.BufferGeometry();
    nodeGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(nodePositions, 3)
    );
    const nodeMaterial = new THREE.PointsMaterial({
      transparent: true,
      sizeAttenuation: false, // orthographic camera: size is in device pixels
    });
    scene.add(new THREE.Points(nodeGeometry, nodeMaterial));

    // ── Pulses: the only thing that moves ───────────────────────────────────
    const pulsePositions = new Float32Array(PULSE_COUNT * 3);
    const pulseGeometry = new THREE.BufferGeometry();
    pulseGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(pulsePositions, 3)
    );
    const pulseMaterial = new THREE.PointsMaterial({
      transparent: true,
      sizeAttenuation: false,
    });
    scene.add(new THREE.Points(pulseGeometry, pulseMaterial));

    const pulses = Array.from({ length: PULSE_COUNT }, (_, i) => ({
      edge: (i * 7) % edges.length,
      t: rand(),
      speed: 0.06 + rand() * 0.09, // full traversal in roughly 7–17s
    }));

    // ── Theme ───────────────────────────────────────────────────────────────
    let dpr = 1;
    const applyPalette = () => {
      const p = document.documentElement.classList.contains('dark')
        ? DARK
        : LIGHT;
      edgeMaterial.color.setHex(p.edge);
      edgeMaterial.opacity = p.edgeOpacity;
      nodeMaterial.color.setHex(p.node);
      nodeMaterial.opacity = p.nodeOpacity;
      nodeMaterial.size = 2.4 * dpr;
      pulseMaterial.color.setHex(p.pulse);
      pulseMaterial.opacity = p.pulseOpacity;
      pulseMaterial.size = 4.2 * dpr;
    };

    const themeObserver = new MutationObserver(applyPalette);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    // ── Sizing: the field always COVERS the viewport, never letterboxes ──────
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = container;
      if (w === 0 || h === 0) return;
      dpr = Math.min(window.devicePixelRatio, 1.5);
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      const aspect = w / h;
      const halfW =
        aspect >= FIELD_HALF_W / FIELD_HALF_H
          ? FIELD_HALF_W
          : FIELD_HALF_H * aspect;
      const halfH =
        aspect >= FIELD_HALF_W / FIELD_HALF_H
          ? FIELD_HALF_W / aspect
          : FIELD_HALF_H;
      camera.left = -halfW;
      camera.right = halfW;
      camera.top = halfH;
      camera.bottom = -halfH;
      camera.updateProjectionMatrix();
      applyPalette(); // point sizes are DPR-scaled, so they move with it
    };

    container.appendChild(renderer.domElement);
    resize();

    // A viewport-FIXED layer that never reacts to scroll reads as a sticker on the
    // glass. Nudging the whole mesh a few percent against the scroll is enough to
    // sell it as depth. Read from a passive listener, not from inside the frame, so
    // the render loop never triggers a layout flush.
    let scrollOffset = 0;
    const onScroll = () => {
      scrollOffset = -(window.scrollY / Math.max(window.innerHeight, 1)) * 0.06;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    // ── Loop ────────────────────────────────────────────────────────────────
    let raf = 0;
    let onScreen = true;
    let lastFrame = 0;
    const frameBudget = 1000 / TARGET_FPS;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!onScreen || document.hidden) {
        lastFrame = now; // resume without a jumped-forward first frame
        return;
      }
      const dt = now - lastFrame;
      if (dt < frameBudget) return;
      lastFrame = now;

      const step = dt / 1000;
      const posAttr = pulseGeometry.getAttribute(
        'position'
      ) as THREE.BufferAttribute;
      for (let i = 0; i < pulses.length; i++) {
        const p = pulses[i];
        p.t += p.speed * step;
        if (p.t >= 1) {
          p.t -= 1;
          // Hop to another edge rather than looping the same wire forever, so the
          // traffic pattern never becomes a recognisable repeat.
          p.edge = (p.edge + 5) % edges.length;
        }
        const [a, b] = edges[p.edge];
        posAttr.setXYZ(
          i,
          nodes[a].x + (nodes[b].x - nodes[a].x) * p.t,
          nodes[a].y + (nodes[b].y - nodes[a].y) * p.t,
          0
        );
      }
      posAttr.needsUpdate = true;

      scene.position.y = scrollOffset;
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
      },
      { threshold: 0 }
    );
    io.observe(container);

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      window.removeEventListener('scroll', onScroll);
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      pulseGeometry.dispose();
      pulseMaterial.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="absolute inset-0 [&>canvas]:block [&>canvas]:h-full [&>canvas]:w-full"
    />
  );
}
