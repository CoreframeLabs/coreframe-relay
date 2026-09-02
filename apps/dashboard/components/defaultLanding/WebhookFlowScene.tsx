import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * [director ask, landing-page visual — split from RELAY-118's motion work]
 *
 * The actual Three.js scene. This file is ONLY ever reached through
 * `WebhookFlowVisual.tsx`'s `next/dynamic(..., { ssr: false })` import — it
 * is never imported directly by any page, and never by anything under
 * `pages/teams/**`, `pages/settings/**` or any other authenticated
 * dashboard route. A data-dense tool people use daily gets zero bytes of
 * this file; only `pages/index.tsx` (via `HeroSection`) does.
 *
 * WHAT IT DRAWS: three glowing points travel, staggered, along one gentle
 * curve from a "sender" position to a "receiver" position, looping forever
 * — an abstract, literal-enough restatement of "a webhook in flight, and it
 * arrives" (this product's actual promise) rather than a decorative shape
 * with no connection to what Relay does. No counters, no numbers, no text
 * render onto the canvas — this is a pure motion accent, so it cannot imply
 * a customer/request volume the honesty bar (RELAY-64) would object to.
 * Colour is the same teal already used for the hero's accent text/glow
 * (`landing-accent`), so it reads as one more shade of the existing design
 * rather than a new decorative language.
 *
 * PERF: one `BufferGeometry` line (the static path, drawn once) + one
 * `Points` object (the three travelling dots, position updated per frame by
 * writing straight into its `Float32Array` — no per-frame allocation).
 * `WebGLRenderer` is created with `alpha: true` and `powerPreference:
 * "low-power"` and capped to `devicePixelRatio <= 2` — this is a background
 * accent, not a hero render target, and has no business asking for a
 * discrete GPU or rendering at 3x DPR. Pauses its own rAF loop via the
 * `IntersectionObserver` below when the canvas scrolls out of view (a
 * visitor who has scrolled past the hero gets zero ongoing GPU/CPU cost)
 * and again on `visibilitychange` (a backgrounded tab costs nothing).
 */
export default function WebhookFlowScene() {
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
      // No WebGL (old browser, disabled GPU, locked-down environment). The
      // static fallback frame `WebhookFlowVisual` already painted before
      // this component ever mounted stays exactly as it is — nothing to
      // clean up, nothing thrown further.
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 8);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const resize = () => {
      const { clientWidth, clientHeight } = container;
      if (clientWidth === 0 || clientHeight === 0) return;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };
    resize();

    // The path a webhook "travels": a single gentle arc, left to right.
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-5, -0.6, 0),
      new THREE.Vector3(-1.8, 1.1, 0.4),
      new THREE.Vector3(1.8, -0.9, -0.4),
      new THREE.Vector3(5, 0.6, 0),
    ]);

    const linePoints = curve.getPoints(64);
    const lineGeometry = new THREE.BufferGeometry().setFromPoints(linePoints);
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x2dd4bf, // landing-accent teal
      transparent: true,
      opacity: 0.16,
    });
    const line = new THREE.Line(lineGeometry, lineMaterial);
    scene.add(line);

    // Three "in-flight" packets, evenly staggered along the same curve.
    const packetCount = 3;
    const positions = new Float32Array(packetCount * 3);
    const packetGeometry = new THREE.BufferGeometry();
    packetGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3)
    );
    const packetMaterial = new THREE.PointsMaterial({
      color: 0x5eead4,
      size: 0.16,
      transparent: true,
      opacity: 0.9,
      sizeAttenuation: true,
    });
    const packets = new THREE.Points(packetGeometry, packetMaterial);
    scene.add(packets);

    const speed = 0.00012; // full traversal roughly every ~8.3s
    let raf = 0;
    let running = true;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!running) return;

      const posAttr = packetGeometry.getAttribute(
        'position'
      ) as THREE.BufferAttribute;
      for (let i = 0; i < packetCount; i++) {
        const offset = i / packetCount;
        const t = ((now * speed + offset) % 1 + 1) % 1; // stagger + wrap into [0,1)
        const p = curve.getPointAt(t);
        posAttr.setXYZ(i, p.x, p.y, p.z);
      }
      posAttr.needsUpdate = true;

      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    // Pause the render loop entirely off-screen or in a backgrounded tab —
    // this is a decorative accent, not something worth spending idle GPU
    // cycles on once a visitor has scrolled past it.
    const io = new IntersectionObserver(
      ([entry]) => {
        running = entry.isIntersecting && !document.hidden;
      },
      { threshold: 0 }
    );
    io.observe(container);

    const onVisibilityChange = () => {
      running = !document.hidden && running;
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      lineGeometry.dispose();
      lineMaterial.dispose();
      packetGeometry.dispose();
      packetMaterial.dispose();
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
      className="h-full w-full [&>canvas]:block [&>canvas]:h-full [&>canvas]:w-full"
    />
  );
}
