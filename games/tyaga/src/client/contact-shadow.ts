import * as THREE from 'three';
import type { Vec3 } from '../core/types';

/** A small ambient contact cue, projected onto the actual support mesh.
 * It reuses its triangles, so the shadow cannot draw a floor across a void.
 * No shadow map, new collider, guessed support plane or external texture. */
export class ContactShadow {
  private uniforms = {
    tyCenter: { value: new THREE.Vector3() }, tyNormal: { value: new THREE.Vector3(0, 1, 0) },
    tyNormalMatrix: { value: new THREE.Matrix3() }, tyU: { value: new THREE.Vector3(1, 0, 0) }, tyV: { value: new THREE.Vector3(0, 0, 1) },
    tyRadius: { value: new THREE.Vector2(1, 1) }, tyOpacity: { value: .25 }, tyColor: { value: new THREE.Color('#27382f') },
  };
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  constructor(own: (resource: THREE.Material | THREE.BufferGeometry) => void) {
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, depthTest: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false,
      vertexShader: `
        varying vec3 vTyWorld;
        varying vec3 vTyNormal;
        uniform mat3 tyNormalMatrix;
        void main() {
          vec4 world = modelMatrix * vec4( position, 1.0 );
          vTyWorld = world.xyz; vTyNormal = normalize( tyNormalMatrix * normal );
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        varying vec3 vTyWorld;
        varying vec3 vTyNormal;
        uniform vec3 tyCenter;
        uniform vec3 tyNormal;
        uniform vec3 tyU;
        uniform vec3 tyV;
        uniform vec2 tyRadius;
        uniform float tyOpacity;
        uniform vec3 tyColor;
        void main() {
          vec3 delta = vTyWorld - tyCenter;
          // Reject walls and other levels of a compound support model.
          if ( dot( normalize( vTyNormal ), tyNormal ) < 0.55 || abs( dot( delta, tyNormal ) ) > 0.18 ) discard;
          vec2 point = vec2( dot( delta, tyU ), dot( delta, tyV ) ) / tyRadius;
          float radius = length( point );
          if ( radius >= 1.0 ) discard;
          float soft = 1.0 - smoothstep( 0.22, 1.0, radius );
          gl_FragColor = vec4( tyColor, tyOpacity * soft * soft );
          #include <colorspace_fragment>
        }`,
    });
    material.name = 'tyaga-contact-shadow@1'; own(geometry); own(material);
    this.mesh = new THREE.Mesh(geometry, material); this.mesh.name = 'contact-shadow'; this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false; this.mesh.renderOrder = 2; this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.userData.decor = true;
  }
  update(support: THREE.Mesh, point: THREE.Vector3, normal: THREE.Vector3, object: THREE.Object3D, size: Vec3, clearance: number, low: boolean) {
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(object.quaternion), y = new THREE.Vector3(0, 1, 0).applyQuaternion(object.quaternion), z = new THREE.Vector3(0, 0, 1).applyQuaternion(object.quaternion);
    const u = this.uniforms.tyU.value.copy(x).addScaledVector(normal, -x.dot(normal));
    if (u.lengthSq() < .01) u.set(1, 0, 0).addScaledVector(normal, -normal.x); u.normalize();
    const v = this.uniforms.tyV.value.crossVectors(u, normal).normalize();
    const half = (axis: THREE.Vector3) => .5 * (Math.abs(x.dot(axis)) * size.x + Math.abs(y.dot(axis)) * size.y + Math.abs(z.dot(axis)) * size.z);
    const height = Math.max(0, clearance), blur = .08 + Math.min(2, height) * .055;
    this.uniforms.tyRadius.value.set(Math.max(.18, half(u) + blur), Math.max(.18, half(v) + blur));
    this.uniforms.tyCenter.value.copy(point); this.uniforms.tyNormal.value.copy(normal);
    this.uniforms.tyNormalMatrix.value.getNormalMatrix(support.matrixWorld);
    this.uniforms.tyOpacity.value = (low ? .27 : .16) / (1 + height * .48) * THREE.MathUtils.clamp((7 - height) / 2, 0, 1);
    // Geometry belongs to the support, not this cue. Its owner disposes it.
    this.mesh.geometry = support.geometry; this.mesh.matrix.copy(support.matrixWorld); this.mesh.matrixWorldNeedsUpdate = true;
    this.mesh.visible = this.uniforms.tyOpacity.value > .005;
  }
}
