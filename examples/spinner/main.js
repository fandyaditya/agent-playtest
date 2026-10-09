// A small but real Three.js game, used to exercise Agent Playtest end to end.
//
// It is deliberately plain JavaScript served without a bundler, so the
// development-only bridge call lives here instead of in `.agent-playtest/bridge.ts`.
// `?agent-playtest=1` is NOT a security boundary: a real project must gate the bridge
// behind a bundler's dev-only condition and verify it is absent from the
// production build.

import { connect } from "agent-playtest/bridge";
import * as THREE from "three";

const WALL_INNER_X = 1.92;
const HERO_HALF_WIDTH = 0.4;
const MAX_HERO_X = WALL_INNER_X - HERO_HALF_WIDTH; // 1.52 — the rule tests assert
const SPEED = 2.5;

const canvas = document.getElementById("game");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.name = "spinner-scene";
scene.background = new THREE.Color("#0b0f19");
scene.fog = new THREE.Fog("#0b0f19", 8, 22);

const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
camera.position.set(0.4, 2.6, 6.4);
camera.lookAt(0.4, 0.6, 0);

scene.add(new THREE.AmbientLight("#94a3b8", 1.4));
const key = new THREE.DirectionalLight("#ffffff", 2.2);
key.position.set(3, 6, 4);
scene.add(key);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(14, 10),
  new THREE.MeshStandardMaterial({ color: "#1e293b", roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
floor.name = "floor";
scene.add(floor);

const hero = new THREE.Mesh(
  new THREE.BoxGeometry(0.8, 0.8, 0.8),
  new THREE.MeshStandardMaterial({ color: "#38bdf8", metalness: 0.25, roughness: 0.35 }),
);
hero.position.set(0, 0.4, 0);
hero.name = "Hero";
hero.userData.agentPlaytest = { id: "main-hero", role: "character" };
scene.add(hero);

const wall = new THREE.Mesh(
  new THREE.BoxGeometry(0.4, 1.6, 3),
  new THREE.MeshStandardMaterial({ color: "#f97316", roughness: 0.6 }),
);
wall.position.set(WALL_INNER_X + 0.2, 0.8, 0);
wall.name = "Wall";
wall.userData.agentPlaytest = { id: "wall" };
scene.add(wall);

const obstacle = new THREE.Mesh(
  new THREE.BoxGeometry(0.6, 0.6, 0.6),
  new THREE.MeshStandardMaterial({ color: "#a78bfa", roughness: 0.5 }),
);
obstacle.position.set(-2.4, 0.3, 0.6);
obstacle.name = "Obstacle";
obstacle.userData.agentPlaytest = { id: "obstacle" };
scene.add(obstacle);

const held = new Set();
const game = {
  paused: false,
  elapsed: 0,
  heroX: 0,
  hits: 0,
};

function tick(dt) {
  game.elapsed += dt;
  const direction = (held.has("ArrowRight") ? 1 : 0) - (held.has("ArrowLeft") ? 1 : 0);
  const next = game.heroX + direction * SPEED * dt;
  const clamped = Math.min(MAX_HERO_X, Math.max(-MAX_HERO_X, next));
  if (direction !== 0 && clamped === game.heroX) game.hits += 1;
  game.heroX = clamped;
  hero.position.x = game.heroX;
  hero.rotation.y += dt * 1.4;
  obstacle.rotation.y += dt * 0.8;
}

function resize() {
  const width = canvas.clientWidth || 960;
  const height = canvas.clientHeight || 540;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!game.paused) tick(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener("keydown", (event) => held.add(event.key));
window.addEventListener("keyup", (event) => held.delete(event.key));

const shouldConnect =
  new URLSearchParams(location.search).get("agent-playtest") === "1" &&
  ["localhost", "127.0.0.1", "::1"].includes(location.hostname);

if (shouldConnect) {
  connect({
    engine: "three",
    scene,
    camera,
    renderer,
    ready: () => scene.children.length > 0,
    subjects: {
      hero: {
        object: hero,
        id: "main-hero",
        forward: [0, 0, -1],
        up: [0, 1, 0],
      },
    },
    simulation: {
      pause() {
        game.paused = true;
      },
      step(dtSeconds) {
        tick(dtSeconds);
      },
      reset(fixture) {
        game.paused = true;
        game.elapsed = 0;
        game.hits = 0;
        held.clear();
        game.heroX = fixture === "near-wall" ? MAX_HERO_X - 0.1 : 0;
        hero.position.x = game.heroX;
      },
      state() {
        return {
          heroX: game.heroX,
          maxHeroX: MAX_HERO_X,
          wallInnerX: WALL_INNER_X,
          touchesWall: game.heroX >= MAX_HERO_X - 1e-9,
          wallHits: game.hits,
          elapsed: game.elapsed,
          paused: game.paused,
        };
      },
      action(name, args) {
        if (name === "hold") {
          held.add(String(args?.key));
          return;
        }
        if (name === "release") {
          held.delete(String(args?.key));
          return;
        }
        throw new Error(`Unknown example action "${name}".`);
      },
    },
  });
}

globalThis.__exampleGame = game;
