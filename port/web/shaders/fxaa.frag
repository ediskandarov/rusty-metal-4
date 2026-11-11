#version 300 es
precision highp float;
#define texture2D texture
#include "fxaa.glsl"

uniform sampler2D frame;
out vec4 color;

void main() {
    vec2 resolution = vec2(textureSize(frame, 0));
    vec2 pixel = 1.0 / resolution;
    vec2 uv = gl_FragCoord.xy * pixel;
    vec2 nw = uv + vec2(-1.0, -1.0) * pixel;
    vec2 ne = uv + vec2( 1.0, -1.0) * pixel;
    vec2 sw = uv + vec2(-1.0,  1.0) * pixel;
    vec2 se = uv + vec2( 1.0,  1.0) * pixel;
    vec4 center = texture(frame, uv);
    vec3 weights = vec3(0.299, 0.587, 0.114);
    float lumaNW = dot(texture(frame, nw).rgb, weights);
    float lumaNE = dot(texture(frame, ne).rgb, weights);
    float lumaSW = dot(texture(frame, sw).rgb, weights);
    float lumaSE = dot(texture(frame, se).rgb, weights);
    float mid = dot(center.rgb, weights);
    float low = min(mid, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
    float high = max(mid, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
    // Preserve low-contrast texture detail instead of smoothing the whole frame.
    if (high - low < max(1.0 / 32.0, high / 8.0)) {
        color = center;
        return;
    }
    color = fxaa(frame, gl_FragCoord.xy, resolution, nw, ne, sw, se, uv);
}
