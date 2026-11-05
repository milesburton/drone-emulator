import * as THREE from 'three';

/** Uniforms shared by every swaying material; render.ts sets them once a frame. */
export const swayUniforms = {
  uTime: { value: 0 },
  uWind: { value: 0 },
  uDir: { value: new THREE.Vector2(1, 0) },
};

type Patch = (shader: THREE.WebGLProgramParametersWithUniforms) => void;

const uniformDeclarations = 'uniform float uTime;\nuniform float uWind;\nuniform vec2 uDir;\n';

/** Adds the shared sway uniforms and swaps `chunk` of the vertex shader for `replacement`. */
const patch =
  (chunk: string, replacement: string, attributes = ''): Patch =>
  (shader) => {
    Object.assign(shader.uniforms, swayUniforms);
    shader.vertexShader =
      uniformDeclarations +
      attributes +
      shader.vertexShader.replace(`#include <${chunk}>`, replacement);
  };

/**
 * Cloth ripple. `aAlong` is the distance from the pole in metres and `aHoist` is 0 at the pole and
 * 1 at the free edge; both are per-vertex so the back face, which is mirrored, waves identically.
 * Calm air lets the cloth hang and droop; wind lifts it flat and sets a travelling wave along it.
 */
export const flagSway = (material: THREE.Material): void => {
  material.onBeforeCompile = patch(
    'begin_vertex',
    `vec3 transformed = vec3(position);
    float phase = modelMatrix[3].x * 0.05 + modelMatrix[3].z * 0.07;
    float speed = 3.0 + uWind * 9.0;
    float wave = sin(aAlong * 0.9 - uTime * speed + phase);
    float flutter = sin(aAlong * 2.3 - uTime * speed * 2.1 + position.y * 0.7 + phase * 2.0);
    float lift = aHoist * aHoist;
    transformed.z += aHoist * (0.15 + uWind * 1.6) * wave + lift * uWind * 0.55 * flutter;
    transformed.y -= (1.0 - uWind) * lift * 4.5;
    transformed.y += uWind * aHoist * 0.4 * sin(aAlong * 0.6 - uTime * speed * 0.7 + phase);`,
    'attribute float aAlong;\nattribute float aHoist;\n',
  );
  material.customProgramCacheKey = () => 'flag-sway';
};

/**
 * Tree sway: a world-space lean downwind that grows with the square of height up the tree, with a
 * slow swing and a quicker shiver whose phase comes from each instance's position.
 */
export const treeSway = (material: THREE.Material, height: number): void => {
  material.onBeforeCompile = patch(
    'project_vertex',
    `vec4 mvPosition = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      mvPosition = instanceMatrix * mvPosition;
      float phase = instanceMatrix[3].x * 0.11 + instanceMatrix[3].z * 0.13;
    #else
      float phase = 0.0;
    #endif
    float h = clamp(position.y / ${height.toFixed(1)}, 0.0, 1.0);
    float swing = 0.55 + 0.3 * sin(uTime * 1.3 + phase) + 0.15 * sin(uTime * 3.1 + phase * 1.7);
    float lean = h * h * uWind * swing * ${(height * 0.14).toFixed(2)};
    mvPosition.xz += uDir * lean;
    mvPosition.xz += vec2(sin(uTime * 2.3 + phase), cos(uTime * 2.7 + phase)) * h * h * (0.05 + uWind * 0.18);
    mvPosition = modelViewMatrix * mvPosition;
    gl_Position = projectionMatrix * mvPosition;`,
  );
  material.customProgramCacheKey = () => 'tree-sway';
};
