/**
 * 3D Wave Grid — grid denso de cubos visto de cima que responde ao mouse
 * com ondas concêntricas (ripple) que se propagam e desvanecem.
 *
 * Port vanilla (sem build) do projeto de Franky Adl:
 *   https://github.com/franky-adl/3d-wave-grid
 *   ref. visual: https://projects.arkon.digital/threejs/wavy-cubes/
 *
 * Uso:
 *   import { initCubeGrid } from './assets/cube-grid.js';
 *   const grid = initCubeGrid(document.querySelector('#cube-grid'), { ...config });
 *   // grid.destroy();
 *
 * Dependência: three + addons de post-processing (via <script type="importmap">).
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const DEFAULTS = {
  gridSize: 40,          // nº de cubos por lado (gridSize² instâncias)
  cubeWidth: 0.8,        // largura/profundidade do cubo
  cubeHeight: 3,         // altura do cubo (pilar)
  gap: 0.01,             // folga entre cubos

  waveAmplitude: 0.4,    // força da onda antes do clamp
  waveSpeed: 6.0,        // unidades de mundo / segundo (velocidade da frente de onda)
  waveFrequency: 1.2,    // rad / unidade (oscilação espacial)
  waveWidth: 3.0,        // meia-largura gaussiana do anel da onda
  waveJitter: 0.2,       // ruído por cubo pra quebrar a regularidade
  waveMaxHeight: 0.4,    // deslocamento Y máximo (clamp)

  fadeTime: 2.0,         // s pra a amplitude cair a ~37%
  trailSpacing: 0.1,     // distância mínima (mundo) entre pontos do rastro
  idle: true,            // solta pontos aleatórios quando o mouse fica parado

  colorBase: '#ffffff',  // cor do cubo em repouso
  colorHigh: '#0cb7f2',  // cor do cubo no pico da onda
  background: null,       // fundo sólido da cena; null => colorBase * 0.5
  backgroundGradient: null, // ['#topo', '#base'] => degradê vertical na cena (tem prioridade)
  backgroundGrain: 0.05, // intensidade da granulação sobre o degradê (0 = liso)

  cameraRadius: 12,      // distância da câmera (olhando de cima)
  cameraFov: 40,
  mouseParallax: true,   // leve inclinação da câmera seguindo o mouse

  exposure: 1.95,        // toneMappingExposure
  vignette: { shiftAmount: 0.005, radius: 0.3, softness: 0.3 }, // aberração cromática + vinheta
};

/* ---------------- Shader da vinheta + RGB shift (post-processing) ---------------- */
const VignetteRGBShiftShader = {
  uniforms: {
    tDiffuse: { value: null },
    shiftAmount: { value: 0.005 },
    vignetteRadius: { value: 0.3 },
    vignetteSoftness: { value: 0.3 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float shiftAmount;
    uniform float vignetteRadius;
    uniform float vignetteSoftness;
    varying vec2 vUv;
    void main() {
      vec2 center = vec2(0.5);
      float dist = distance(vUv, center);
      float horzQuadrant = sign(vUv.x - center.x);
      float vertQuadrant = sign(vUv.y - center.y);
      float vignetteFactor = smoothstep(vignetteRadius, vignetteRadius + vignetteSoftness, dist);
      float currentShift = shiftAmount * vignetteFactor;
      float r = texture2D(tDiffuse, vUv + vec2(currentShift * horzQuadrant, currentShift * vertQuadrant)).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - vec2(currentShift * horzQuadrant, currentShift * vertQuadrant)).b;
      float darken = 1.0 - vignetteFactor * 0.5;
      gl_FragColor = vec4(vec3(r, g, b) * darken, 1.0);
    }
  `,
};

const MAX_TRAIL = 128;

export function initCubeGrid(container, userOptions = {}) {
  if (!container) throw new Error('[cube-grid] container inválido');

  const opts = { ...DEFAULTS, ...userOptions, vignette: { ...DEFAULTS.vignette, ...(userOptions.vignette || {}) } };
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const spacing = opts.cubeWidth + opts.gap;
  const bounds = opts.gridSize * spacing; // footprint total do grid (mundo)

  const size = () => ({
    w: container.clientWidth || window.innerWidth,
    h: container.clientHeight || window.innerHeight,
    dpr: Math.min(window.devicePixelRatio, 2),
  });

  /* ---------------- Renderer ---------------- */
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const bgColor = new THREE.Color(opts.background != null ? opts.background : opts.colorBase);
  if (opts.background == null && opts.backgroundGradient == null) bgColor.multiplyScalar(0.5);
  renderer.setClearColor(bgColor);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  container.appendChild(renderer.domElement);

  /* ---------------- Cena / câmera ---------------- */
  const scene = new THREE.Scene();

  // Fundo: degradê vertical com granulação leve (CanvasTexture) ou cor sólida
  let bgTexture = null;
  if (Array.isArray(opts.backgroundGradient) && opts.backgroundGradient.length >= 2) {
    const c = document.createElement('canvas');
    c.width = 2; c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0, opts.backgroundGradient[0]);
    g.addColorStop(1, opts.backgroundGradient[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    const grain = Math.max(0, opts.backgroundGrain) * 255;
    if (grain > 0) {
      const img = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < img.data.length; i += 4) {
        const n = (Math.random() - 0.5) * grain;
        img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
      }
      ctx.putImageData(img, 0, 0);
    }
    bgTexture = new THREE.CanvasTexture(c);
    bgTexture.colorSpace = THREE.SRGBColorSpace;
    scene.background = bgTexture;
  } else {
    scene.background = bgColor;
  }

  const camera = new THREE.PerspectiveCamera(opts.cameraFov, 1, 0.1, 200);
  const alphaRange = Math.PI * 0.03; // mouse Y -> rot. em X (±~14°)
  const betaRange = Math.PI * 0.05;  // mouse X -> rot. em Z (±~22°)
  const mouse = new THREE.Vector2(0, 0);
  const lerpedMouse = new THREE.Vector2(0, 0);

  function placeCamera(mx, my) {
    const alpha = (opts.mouseParallax ? my : 0) * alphaRange;
    const beta = (opts.mouseParallax ? mx : 0) * betaRange;
    const r = opts.cameraRadius;
    camera.position.set(
      -r * Math.cos(alpha) * Math.sin(beta),
      r * Math.cos(alpha) * Math.cos(beta),
      r * Math.sin(alpha),
    );
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
  }
  placeCamera(0, 0);

  /* ---------------- Luzes ---------------- */
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));

  const key = new THREE.DirectionalLight(0xffffff, 4.0);
  key.position.set(-20, 10, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 6;
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 60;
  key.shadow.camera.left = -22;
  key.shadow.camera.right = 22;
  key.shadow.camera.top = 22;
  key.shadow.camera.bottom = -22;
  key.shadow.bias = 0.0001;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 1.0);
  fill.position.set(10, 5, -3);
  scene.add(fill);

  /* ---------------- Rastro do mouse (DataTexture 128×1) ---------------- */
  const trailData = new Float32Array(MAX_TRAIL * 4); // (x, z, age, distDelta)
  const trailTexture = new THREE.DataTexture(trailData, MAX_TRAIL, 1, THREE.RGBAFormat, THREE.FloatType);
  trailTexture.needsUpdate = true;

  const trailUniforms = {
    uTrailTexture: { value: trailTexture },
    uTrailCount: { value: 0 },
    uFadeTime: { value: opts.fadeTime },
  };

  const trail = [];             // [{ x, z, age, distDelta }]
  let lastPoint = null;
  let timeSinceMove = 0;
  let randomTimer = 0;
  let placingRandom = opts.idle && !prefersReducedMotion;

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  const ndc = new THREE.Vector2();
  let rect = renderer.domElement.getBoundingClientRect();

  function onPointerMove(e) {
    mouse.x = (e.clientX / size().w) * 2 - 1;
    mouse.y = -(e.clientY / size().h) * 2 + 1;

    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(groundPlane, hit)) return;

    let distDelta = 0;
    if (lastPoint) {
      const dx = hit.x - lastPoint.x;
      const dz = hit.z - lastPoint.z;
      distDelta = Math.sqrt(dx * dx + dz * dz);
      if (distDelta < opts.trailSpacing) return;
    }
    if (trail.length >= MAX_TRAIL) trail.shift();
    trail.push({ x: hit.x, z: hit.z, age: 0, distDelta });
    lastPoint = { x: hit.x, z: hit.z };

    timeSinceMove = 0;
    placingRandom = false;
    randomTimer = 0;
  }

  function addRandomPoint() {
    const x = (Math.random() * 0.5 - 0.25) * bounds;
    const z = (Math.random() * 0.5 - 0.25) * bounds;
    const distDelta = 0.8 + Math.random() * 0.2;
    if (trail.length >= MAX_TRAIL) trail.shift();
    trail.push({ x, z, age: 0, distDelta });
  }

  function updateTrail(delta) {
    const expiry = opts.fadeTime * 4;
    for (let i = trail.length - 1; i >= 0; i--) {
      trail[i].age += delta;
      if (trail[i].age > expiry) trail.splice(i, 1);
    }

    timeSinceMove += delta;
    if (opts.idle && !prefersReducedMotion) {
      if (timeSinceMove >= 3.0 && !placingRandom) { placingRandom = true; randomTimer = 0; }
      if (placingRandom) {
        randomTimer += delta;
        if (randomTimer >= 1.5) { addRandomPoint(); randomTimer = 0; }
      }
    }

    const count = Math.min(trail.length, MAX_TRAIL);
    if (count > 0 || trailUniforms.uTrailCount.value > 0) {
      for (let i = 0; i < count; i++) {
        const ti = i * 4;
        trailData[ti] = trail[i].x;
        trailData[ti + 1] = trail[i].z;
        trailData[ti + 2] = trail[i].age;
        trailData[ti + 3] = trail[i].distDelta;
      }
      trailTexture.needsUpdate = true;
      trailUniforms.uTrailCount.value = count;
    }
  }

  /* ---------------- Grid instanciado + injeção de shader ---------------- */
  // Deformação de onda no vertex shader — compartilhada entre material principal
  // e material de profundidade (pra a sombra acompanhar a onda).
  function overrideVertexShader(vertexShader) {
    return vertexShader
      .replace('#include <common>', /* glsl */`#include <common>
        varying float vHeight;
        attribute vec2 aOffset;
        uniform sampler2D uTrailTexture;
        uniform int   uTrailCount;
        uniform float uWaveSpeed;
        uniform float uWaveFreq;
        uniform float uWaveWidth;
        uniform float uFadeTime;
        uniform float uAmplitude;
        uniform float uJitter;
        uniform float uMaxHeight;
        vec2 hash2( vec2 p ) {
          p = vec2( dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)) );
          return fract( sin(p) * 43758.5453123 ) - 0.5;
        }`)
      .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
        vHeight = 0.0;
        if ( position.y > 0.0 ) {
          vec2 jitter  = hash2( aOffset ) * uJitter;
          vec2 worldXZ = aOffset + jitter;
          float waveHeight  = 0.0;
          float totalWeight = 0.0;
          for ( int i = 0; i < uTrailCount; i++ ) {
            vec4 td = texture2D( uTrailTexture, vec2( ( float(i) + 0.5 ) / 128.0, 0.5 ) );
            float dist      = length( worldXZ - td.rg );
            float wavefront = uWaveSpeed * td.b;
            float relDist   = dist - wavefront;
            float window = exp( -( relDist * relDist ) / ( uWaveWidth * uWaveWidth ) );
            float fade   = exp( -td.b / uFadeTime );
            float atten  = 1.0 / ( 1.0 + dist * 0.1 );
            float weight = fade * window * atten * td.a;
            waveHeight  += weight * cos( uWaveFreq * relDist );
            totalWeight += weight;
          }
          waveHeight /= max( totalWeight, 1.0 );
          float displacement = clamp( waveHeight * uAmplitude, -uMaxHeight, uMaxHeight );
          transformed.y += displacement;
          vHeight = displacement;
        }`);
  }

  const geometry = new THREE.BoxGeometry(opts.cubeWidth, opts.cubeHeight, opts.cubeWidth);
  const count = opts.gridSize * opts.gridSize;
  const offsetAttribute = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
  geometry.setAttribute('aOffset', offsetAttribute);

  const colorBase = new THREE.Color(opts.colorBase);
  const colorHigh = new THREE.Color(opts.colorHigh);
  let shaderRef = null;

  const material = new THREE.MeshPhongMaterial({ color: 0xffffff });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTrailTexture = trailUniforms.uTrailTexture;
    shader.uniforms.uTrailCount = trailUniforms.uTrailCount;
    shader.uniforms.uFadeTime = trailUniforms.uFadeTime;
    shader.uniforms.uWaveSpeed = { value: opts.waveSpeed };
    shader.uniforms.uWaveFreq = { value: opts.waveFrequency };
    shader.uniforms.uWaveWidth = { value: opts.waveWidth };
    shader.uniforms.uAmplitude = { value: opts.waveAmplitude };
    shader.uniforms.uJitter = { value: opts.waveJitter };
    shader.uniforms.uMaxHeight = { value: opts.waveMaxHeight };
    shader.uniforms.uColorBase = { value: colorBase };
    shader.uniforms.uColorHigh = { value: colorHigh };
    shader.vertexShader = overrideVertexShader(shader.vertexShader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vHeight;
        uniform vec3  uColorBase;
        uniform vec3  uColorHigh;
        uniform float uMaxHeight;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float t = clamp( vHeight / uMaxHeight, 0.0, 1.0 );
        diffuseColor.rgb = mix( uColorBase, uColorHigh, t );`);
    shaderRef = shader;
  };

  const depthMaterial = new THREE.MeshDepthMaterial();
  depthMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uTrailTexture = trailUniforms.uTrailTexture;
    shader.uniforms.uTrailCount = trailUniforms.uTrailCount;
    shader.uniforms.uFadeTime = trailUniforms.uFadeTime;
    shader.uniforms.uWaveSpeed = { value: opts.waveSpeed };
    shader.uniforms.uWaveFreq = { value: opts.waveFrequency };
    shader.uniforms.uWaveWidth = { value: opts.waveWidth };
    shader.uniforms.uAmplitude = { value: opts.waveAmplitude };
    shader.uniforms.uJitter = { value: opts.waveJitter };
    shader.uniforms.uMaxHeight = { value: opts.waveMaxHeight };
    shader.vertexShader = overrideVertexShader(shader.vertexShader);
  };

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.customDepthMaterial = depthMaterial;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  (() => {
    const dummy = new THREE.Object3D();
    const offset = ((opts.gridSize - 1) * spacing) / 2;
    for (let i = 0; i < opts.gridSize; i++) {
      for (let j = 0; j < opts.gridSize; j++) {
        const index = i * opts.gridSize + j;
        const x = i * spacing - offset;
        const z = j * spacing - offset;
        dummy.position.set(x, 0, z);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
        offsetAttribute.setXY(index, x, z);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    offsetAttribute.needsUpdate = true;
  })();

  /* ---------------- Post-processing ---------------- */
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const vignettePass = new ShaderPass(VignetteRGBShiftShader);
  vignettePass.uniforms.shiftAmount.value = opts.vignette.shiftAmount;
  vignettePass.uniforms.vignetteRadius.value = opts.vignette.radius;
  vignettePass.uniforms.vignetteSoftness.value = opts.vignette.softness;
  composer.addPass(vignettePass);
  composer.addPass(new OutputPass());

  function applySize() {
    resizeQueued = false;
    const { w, h, dpr } = size();
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    rect = renderer.domElement.getBoundingClientRect();
  }

  /* ---------------- Loop ---------------- */
  const clock = new THREE.Clock();
  let rafId = null;
  let running = false;
  let resizeQueued = false;

  function frame() {
    if (!running) { rafId = null; return; }
    rafId = requestAnimationFrame(frame);
    const delta = Math.min(clock.getDelta(), 0.05);

    // parallax da câmera (lerp suave em direção ao cursor)
    lerpedMouse.x += (mouse.x - lerpedMouse.x) * 0.04;
    lerpedMouse.y += (mouse.y - lerpedMouse.y) * 0.04;
    placeCamera(lerpedMouse.x, lerpedMouse.y);

    updateTrail(delta);
    composer.render();
  }
  function start() { if (!running) { running = true; clock.getDelta(); frame(); } }
  function stop() { running = false; if (rafId != null) cancelAnimationFrame(rafId); rafId = null; }

  /* ---------------- Listeners ---------------- */
  function onResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(applySize);
  }
  function onVisibility() { if (document.hidden) stop(); else start(); }

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  const ro = 'ResizeObserver' in window ? new ResizeObserver(onResize) : null;
  if (ro) ro.observe(container);

  applySize();

  if (prefersReducedMotion) {
    composer.render(); // render estático único
  } else {
    start();
  }

  /* ---------------- Cleanup ---------------- */
  function destroy() {
    stop();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    if (ro) ro.disconnect();
    geometry.dispose();
    material.dispose();
    depthMaterial.dispose();
    mesh.dispose();
    trailTexture.dispose();
    if (bgTexture) bgTexture.dispose();
    composer.passes.forEach((p) => p.dispose && p.dispose());
    composer.dispose && composer.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
  }

  return {
    destroy, scene, camera, renderer, composer, options: opts,
    get shader() { return shaderRef; },
  };
}

export default initCubeGrid;
