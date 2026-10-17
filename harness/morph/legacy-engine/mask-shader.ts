/** Liquid mask deformation, ported from the African collection prototype.
 * Uses core's rasterized SDF and the same media/parameter contract as other morphs. */
import { surfaceGLSL, type SurfaceOptions } from '../../../packages/morph/src/surface.js'

export function liquidMaskShader(reverse: boolean, options: SurfaceOptions = {}): string {
  return `#version 300 es
precision mediump float;
out vec4 outColor;

      uniform vec2 u_resolution;
      uniform float u_progress;
      uniform float u_velocity;
      uniform vec2 u_mouse;
      uniform float u_mediaAspect;
      uniform sampler2D u_media;
      uniform sampler2D u_mask;
      uniform float u_maskScale;
      in vec2 v_uv;

      float roundedBox(vec2 point, vec2 size, float radius) {
        vec2 q = abs(point) - size + radius;
        return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
      }

      ${options.glass || options.outline ? surfaceGLSL(options) : ''}
      void main() {
        float p = smoothstep(.04, .96, ${reverse ? '1.0 - u_progress' : 'u_progress'});
        vec2 point = v_uv - .5;
        point.y += sin(v_uv.x * 3.14159265) * u_velocity * .028;
        point.x += cos(v_uv.y * 6.2831853) * u_velocity * .014;

        float liquidPhase = sin(p * 3.14159265);
        vec2 maskUv = v_uv;
        maskUv.x += (
          sin(v_uv.y * 18.0 + p * 8.0) +
          sin((v_uv.x + v_uv.y) * 29.0 - p * 5.0) * .45
        ) * .013 * liquidPhase;
        maskUv.y += (
          sin(v_uv.x * 15.0 - p * 7.0) +
          cos((v_uv.x - v_uv.y) * 24.0 + p * 6.0) * .40
        ) * .012 * liquidPhase;

        float squareDistance = roundedBox(point, vec2(.46), .035);
        float maskBounds = step(0.0, maskUv.x) * step(maskUv.x, 1.0) * step(0.0, maskUv.y) * step(maskUv.y, 1.0);
        float maskDistance = (texture(u_mask, clamp(maskUv, 0.0, 1.0)).r - .5) * (2.0 * u_maskScale);
        maskDistance = mix(.22, maskDistance, maskBounds);
        maskDistance += (
          sin((maskUv.x + maskUv.y) * 31.0 + p * 10.0) +
          sin(maskUv.y * 43.0 - p * 8.0)
        ) * .0065 * liquidPhase;

        float distance = mix(squareDistance, maskDistance, p) - liquidPhase * .010;
        float edgeSoftness = max(fwidth(distance), 1.15 / min(u_resolution.x, u_resolution.y));
        float alpha = 1.0 - smoothstep(-edgeSoftness, edgeSoftness, distance);
        vec2 distanceGradient = vec2(dFdx(distance), dFdy(distance));
        vec2 surfaceNormal = distanceGradient / max(length(distanceGradient), .00001);
        float edgeDepth = clamp(-distance / .035, 0.0, 1.0);
        float glassLip = (1.0 - smoothstep(.05, 1.0, edgeDepth)) * liquidPhase;

        vec2 videoUv = v_uv;
        if (u_mediaAspect > 1.0) {
          videoUv.x = (videoUv.x - .5) / u_mediaAspect + .5;
        } else {
          videoUv.y = (videoUv.y - .5) * u_mediaAspect + .5;
        }
        videoUv = videoUv - u_mouse * .018;
        vec2 refractedUv = videoUv + surfaceNormal * glassLip * (.011 + abs(u_velocity) * .006);
        vec2 fringe = surfaceNormal * glassLip * .0022;
        vec2 safeUv = clamp(refractedUv, 0.0, 1.0);
        vec4 centerSample = texture(u_media, safeUv);
        vec3 centerColor = centerSample.rgb;
        vec3 color = vec3(
          texture(u_media, clamp(safeUv + fringe, 0.0, 1.0)).r,
          centerColor.g,
          texture(u_media, clamp(safeUv - fringe, 0.0, 1.0)).b
        );
        color += vec3(.92, 1.0, .96) * glassLip * .16;
        float outAlpha = alpha * centerSample.a;
        outColor = ${options.glass || options.outline ? 'shadeSurface(videoUv, distance, alpha)' : 'vec4(color * outAlpha, outAlpha)'};
      }
    `
}
