import * as THREE from 'three';

export function setupLighting(scene: THREE.Scene): void {
  // Hemisphere light for ambient illumination
  const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.35);
  hemisphereLight.position.set(0, 20, 0);
  scene.add(hemisphereLight);

  // Directional light for shadows and definition
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.8);
  directionalLight.position.set(5, 10, 7.5);
  directionalLight.castShadow = true;

  // Configure shadow properties
  directionalLight.shadow.camera.left = -10;
  directionalLight.shadow.camera.right = 10;
  directionalLight.shadow.camera.top = 10;
  directionalLight.shadow.camera.bottom = -10;
  directionalLight.shadow.camera.near = 0.5;
  directionalLight.shadow.camera.far = 50;
  directionalLight.shadow.mapSize.width = 2048;
  directionalLight.shadow.mapSize.height = 2048;

  scene.add(directionalLight);

  // Fill light from the opposite side
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.675);
  fillLight.position.set(-5, 5, -5);
  scene.add(fillLight);
}
