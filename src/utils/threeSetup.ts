import * as THREE from 'three';

export interface ThreeSetupResult {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
}

export function createScene(): THREE.Scene {
  const scene = new THREE.Scene();
  // No background - renderer will be transparent, CSS --bg controls the color
  scene.background = null;
  return scene;
}

export function createCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000);
  camera.position.set(5, 5, 5);
  camera.lookAt(0, 0, 0);
  return camera;
}

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x000000, 0); // Fully transparent — CSS controls bg
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

export interface ThreeHelpers {
  grid: THREE.GridHelper;
  axes: THREE.Group;
  shadowPlane: THREE.Mesh;
}

/**
 * Axis colours, matched to the navigation gizmo's balls (`--gizmo-x/y/z` in
 * ViewGizmo.css). They used to be full-saturation RGB, which read as three
 * neon lines across the viewport and disagreed with the widget that names the
 * same axes.
 */
const AXIS_COLORS = { x: 0xf2564b, y: 0x6fd44f, z: 0x5b8dff } as const;

/** Axis length in world units. Short and semi-transparent so the axes read as
 * an origin marker rather than three lines crossing the whole scene. */
const AXIS_LENGTH = 1.0;
const AXIS_OPACITY = 0.55;

export function addHelpers(scene: THREE.Scene): ThreeHelpers {
  // Grid: a brighter centre cross over dimmer cells, both lifted enough to
  // stay legible on the dark viewport ground.
  const gridHelper = new THREE.GridHelper(20, 20, 0x5a5f6d, 0x33373f);
  const gridMat = gridHelper.material as THREE.Material;
  gridMat.transparent = true;
  gridMat.opacity = 0.7;
  scene.add(gridHelper);

  // Group for all axis components
  const axesGroup = new THREE.Group();
  
  // Custom Axis helper using tubes with triangle cross-sections
  // to avoid z-fighting with the grid lines
  const axisLength = AXIS_LENGTH;
  const axisRadius = 0.005; 
  const triangleSegments = 3; 
  
  // X axis (red)
  const xGeo = new THREE.CylinderGeometry(axisRadius, axisRadius, axisLength, triangleSegments);
  const xMat = new THREE.MeshBasicMaterial({ 
    color: AXIS_COLORS.x,
    transparent: true,
    opacity: AXIS_OPACITY,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1 
  });
  const xAxis = new THREE.Mesh(xGeo, xMat);
  xAxis.rotation.z = -Math.PI / 2;
  xAxis.position.x = axisLength / 2;
  axesGroup.add(xAxis);
  
  // Y axis (green)
  const yGeo = new THREE.CylinderGeometry(axisRadius, axisRadius, axisLength, triangleSegments);
  const yMat = new THREE.MeshBasicMaterial({ 
    color: AXIS_COLORS.y,
    transparent: true,
    opacity: AXIS_OPACITY,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1 
  });
  const yAxis = new THREE.Mesh(yGeo, yMat);
  yAxis.position.y = axisLength / 2;
  axesGroup.add(yAxis);
  
  // Z axis (blue)
  const zGeo = new THREE.CylinderGeometry(axisRadius, axisRadius, axisLength, triangleSegments);
  const zMat = new THREE.MeshBasicMaterial({ 
    color: AXIS_COLORS.z,
    transparent: true,
    opacity: AXIS_OPACITY,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1 
  });
  const zAxis = new THREE.Mesh(zGeo, zMat);
  zAxis.rotation.x = Math.PI / 2;
  zAxis.position.z = axisLength / 2;
  axesGroup.add(zAxis);
  
  scene.add(axesGroup);

  // Ground Shadow Plane (Priority #1 feature)
  // ShadowMaterial only renders the shadow, transparent otherwise
  const shadowPlaneGeo = new THREE.PlaneGeometry(20, 20);
  const shadowPlaneMat = new THREE.ShadowMaterial({ opacity: 0.35 });
  const shadowPlane = new THREE.Mesh(shadowPlaneGeo, shadowPlaneMat);
  
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = -0.001; // Tiny offset below grid to avoid Z-fighting
  shadowPlane.receiveShadow = true;
  scene.add(shadowPlane);

  return { grid: gridHelper, axes: axesGroup, shadowPlane };
}

export interface SetupResult extends ThreeSetupResult {
  helpers: ThreeHelpers;
}

export function setupThreeScene(canvas: HTMLCanvasElement): SetupResult {
  const scene = createScene();
  const camera = createCamera(canvas.clientWidth / canvas.clientHeight);
  const renderer = createRenderer(canvas);

  // Set initial size
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);

  // Add helpers and get references
  const helpers = addHelpers(scene);

  return { scene, camera, renderer, helpers };
}
