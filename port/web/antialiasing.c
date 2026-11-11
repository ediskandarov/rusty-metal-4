#include "antialiasing.h"
#include "antialiasing_shaders.h"
#include "browser_report.h"
#include "external/smaa/Textures/AreaTex.h"
#include "external/smaa/Textures/SearchTex.h"
#include <GLES3/gl3.h>
#include <stdio.h>
#include <stdlib.h>

static int enabled;
static int failed;
static GLuint program, texture, vertex_array, output_texture, output_framebuffer;
static GLuint smaa_programs[3], smaa_targets[2], smaa_framebuffers[2];
static GLuint area_texture, search_texture;
static int smaa_width, smaa_height, lookup_ready;
static int texture_width, texture_height;

/* Filter a private copy at the rendering resolution, before the presentation
 * blit scales it to the window. Never modify PS1 VRAM or the game canvas. */

/* SMAA 1x, using the upstream GLSL path and unmodified lookup tables. Offsets
 * normally interpolated by the vertex shader are evaluated per pixel here. */
static const char smaa_prefix[] = "#version 300 es\n"
                                  "precision highp float;\n"
                                  "precision highp int;\n"
                                  "#define SMAA_GLSL_3\n"
                                  "#define SMAA_PRESET_ULTRA\n"
                                  "uniform vec4 SMAA_RT_METRICS;\n";
static const char* smaa_passes[] = {
    "uniform sampler2D frame;\n"
    "out vec4 color;\n"
    "void main() {\n"
    "    vec2 uv = gl_FragCoord.xy * SMAA_RT_METRICS.xy;\n"
    "    vec4 offsets[3];\n"
    "    SMAAEdgeDetectionVS(uv, offsets);\n"
    "    color = vec4(SMAALumaEdgeDetectionPS(uv, offsets, frame), 0.0, 0.0);\n"
    "}\n",
    "uniform sampler2D edges, area, search;\n"
    "out vec4 color;\n"
    "void main() {\n"
    "    vec2 uv = gl_FragCoord.xy * SMAA_RT_METRICS.xy;\n"
    "    vec4 offsets[3];\n"
    "    vec2 pixel;\n"
    "    SMAABlendingWeightCalculationVS(uv, pixel, offsets);\n"
    "    color = SMAABlendingWeightCalculationPS(uv, pixel, offsets, edges, area, search, vec4(0.0));\n"
    "}\n",
    "uniform sampler2D frame, blend;\n"
    "out vec4 color;\n"
    "void main() {\n"
    "    vec2 uv = gl_FragCoord.xy * SMAA_RT_METRICS.xy;\n"
    "    vec4 offset;\n"
    "    SMAANeighborhoodBlendingVS(uv, offset);\n"
    "    color = SMAANeighborhoodBlendingPS(uv, offset, frame, blend);\n"
    "}\n",
};

static GLuint compile_shader(GLenum kind, int count, const char* const* source)
{
    GLuint shader = glCreateShader(kind);
    glShaderSource(shader, count, source, NULL);
    glCompileShader(shader);
    GLint ok;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[2048];
        glGetShaderInfoLog(shader, sizeof(log), NULL, log);
        fprintf(stderr, "Antialiasing shader: %s\n", log);
        glDeleteShader(shader);
        return 0;
    }
    return shader;
}

static GLuint create_program(int count, const char* const* source)
{
    const char* vertex_text = vertex_source;
    GLuint vertex = compile_shader(GL_VERTEX_SHADER, 1, &vertex_text);
    GLuint fragment = compile_shader(GL_FRAGMENT_SHADER, count, source);
    GLuint result = 0;
    if (vertex && fragment) {
        result = glCreateProgram();
        glAttachShader(result, vertex);
        glAttachShader(result, fragment);
        glLinkProgram(result);
        GLint ok;
        glGetProgramiv(result, GL_LINK_STATUS, &ok);
        if (!ok) {
            char log[2048];
            glGetProgramInfoLog(result, sizeof(log), NULL, log);
            fprintf(stderr, "Antialiasing program: %s\n", log);
            glDeleteProgram(result);
            result = 0;
        }
    }
    if (vertex)
        glDeleteShader(vertex);
    if (fragment)
        glDeleteShader(fragment);
    return result;
}

void WebAntialiasingShutdown(void)
{
    glDeleteProgram(program);
    for (int i = 0; i < 3; ++i) {
        glDeleteProgram(smaa_programs[i]);
        smaa_programs[i] = 0;
    }
    glDeleteTextures(1, &texture);
    glDeleteTextures(1, &output_texture);
    glDeleteFramebuffers(1, &output_framebuffer);
    glDeleteTextures(2, smaa_targets);
    glDeleteTextures(1, &area_texture);
    glDeleteTextures(1, &search_texture);
    glDeleteFramebuffers(2, smaa_framebuffers);
    glDeleteVertexArrays(1, &vertex_array);
    program = texture = vertex_array = area_texture = search_texture = 0;
    output_texture = output_framebuffer = 0;
    smaa_targets[0] = smaa_targets[1] = 0;
    smaa_framebuffers[0] = smaa_framebuffers[1] = 0;
    texture_width = texture_height = smaa_width = smaa_height = lookup_ready = 0;
    failed = 0;
}

static int initialize(void)
{
    if (failed)
        return 0;
    if (!vertex_array) {
        glGenTextures(1, &texture);
        glGenTextures(1, &output_texture);
        glGenFramebuffers(1, &output_framebuffer);
        glGenVertexArrays(1, &vertex_array);
    }
    if (enabled == 1 && !program) {
        const char* source = fragment_source;
        program = create_program(1, &source);
        if (!program)
            failed = 1;
    }
    if (enabled == 2 && !smaa_programs[0]) {
        for (int i = 0; i < 3; ++i) {
            const char* source[] = { smaa_prefix, smaa_source, smaa_passes[i] };
            smaa_programs[i] = create_program(3, source);
            if (!smaa_programs[i])
                failed = 1;
        }
        glGenTextures(2, smaa_targets);
        glGenTextures(1, &area_texture);
        glGenTextures(1, &search_texture);
        glGenFramebuffers(2, smaa_framebuffers);
    }
    if (failed)
        WEB_BROWSER_REPORT({ tm4Port.antialiasingFailed = true; });
    return !failed;
}

static void allocate_texture(
    GLuint id, GLint internal_format, int width, int height, GLenum format, const void* data)
{
    glBindTexture(GL_TEXTURE_2D, id);
    glTexImage2D(
        GL_TEXTURE_2D, 0, internal_format, width, height, 0, format, GL_UNSIGNED_BYTE, data);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
}

static void bind_input(GLuint pass, const char* name, int unit, GLuint id)
{
    glActiveTexture(GL_TEXTURE0 + unit);
    glBindTexture(GL_TEXTURE_2D, id);
    glUniform1i(glGetUniformLocation(pass, name), unit);
}

static void render_smaa(void)
{
    glActiveTexture(GL_TEXTURE0);
    if (!lookup_ready) {
        allocate_texture(area_texture, GL_RG8, AREATEX_WIDTH, AREATEX_HEIGHT, GL_RG, areaTexBytes);
        allocate_texture(
            search_texture, GL_R8, SEARCHTEX_WIDTH, SEARCHTEX_HEIGHT, GL_RED, searchTexBytes);
        lookup_ready = 1;
    }
    if (smaa_width != texture_width || smaa_height != texture_height) {
        for (int i = 0; i < 2; ++i) {
            allocate_texture(
                smaa_targets[i], GL_RGBA8, texture_width, texture_height, GL_RGBA, NULL);
            glBindFramebuffer(GL_DRAW_FRAMEBUFFER, smaa_framebuffers[i]);
            glFramebufferTexture2D(
                GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, smaa_targets[i], 0);
            if (glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
                fprintf(stderr, "Antialiasing framebuffer incomplete\n");
                failed = 1;
                WEB_BROWSER_REPORT({ tm4Port.antialiasingFailed = true; });
                return;
            }
        }
        smaa_width = texture_width;
        smaa_height = texture_height;
    }
    for (int i = 0; i < 3; ++i) {
        GLuint pass = smaa_programs[i];
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, i < 2 ? smaa_framebuffers[i] : output_framebuffer);
        if (i < 2) {
            /* Edge detection discards non-edges; stale weights must never survive. */
            const GLfloat clear[] = { 0, 0, 0, 0 };
            glClearBufferfv(GL_COLOR, 0, clear);
        }
        glUseProgram(pass);
        glUniform4f(glGetUniformLocation(pass, "SMAA_RT_METRICS"), 1.0f / texture_width,
            1.0f / texture_height, texture_width, texture_height);
        if (i == 1) {
            bind_input(pass, "edges", 0, smaa_targets[0]);
            bind_input(pass, "area", 1, area_texture);
            bind_input(pass, "search", 2, search_texture);
        } else {
            bind_input(pass, "frame", 0, texture);
            if (i == 2)
                bind_input(pass, "blend", 1, smaa_targets[1]);
        }
        glDrawArrays(GL_TRIANGLES, 0, 3);
    }
}

EMSCRIPTEN_KEEPALIVE void WebSetAntialiasing(int value)
{
    if (value < 0 || value > 2)
        return;
    enabled = value;
}

int WebAntialiasingPresent(unsigned framebuffer, const int source[4], const int destination[4])
{
    static int reported = -1;
    if (reported != enabled) {
        reported = enabled;
        WEB_BROWSER_REPORT({ tm4Port.antialiasing = $0; }, enabled);
    }
    int width = abs(source[2] - source[0]);
    int height = abs(source[3] - source[1]);
    if (!enabled || !width || !height || !initialize())
        return 0;

    /* The presentation filter shares PsyZ's GL context. Restore every state we touch,
     * including texture bindings, pixel unpack state and the read framebuffer. */
    GLint viewport[4], previous_program, previous_vao, read_fbo, draw_fbo;
    GLint active_texture, previous_texture[3], previous_sampler[3], unpack_buffer;
    const GLenum unpack_names[]
        = { GL_UNPACK_ALIGNMENT, GL_UNPACK_ROW_LENGTH, GL_UNPACK_SKIP_ROWS, GL_UNPACK_SKIP_PIXELS };
    GLint unpack_values[4];
    GLboolean color_mask[4];
    GLboolean clip_to_display = glIsEnabled(GL_SCISSOR_TEST);
    const GLenum capabilities[] = { GL_BLEND, GL_DEPTH_TEST, GL_STENCIL_TEST, GL_SCISSOR_TEST,
        GL_CULL_FACE, GL_RASTERIZER_DISCARD, GL_DITHER };
    GLboolean capability_enabled[sizeof(capabilities) / sizeof(capabilities[0])];
    glGetIntegerv(GL_VIEWPORT, viewport);
    glGetIntegerv(GL_CURRENT_PROGRAM, &previous_program);
    glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &previous_vao);
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read_fbo);
    glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw_fbo);
    glGetIntegerv(GL_ACTIVE_TEXTURE, &active_texture);
    glGetBooleanv(GL_COLOR_WRITEMASK, color_mask);
    glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &unpack_buffer);
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
    for (int i = 0; i < 4; ++i) {
        glGetIntegerv(unpack_names[i], &unpack_values[i]);
        glPixelStorei(unpack_names[i], i == 0 ? 1 : 0);
    }
    for (int i = 0; i < 3; ++i) {
        glActiveTexture(GL_TEXTURE0 + i);
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &previous_texture[i]);
        glGetIntegerv(GL_SAMPLER_BINDING, &previous_sampler[i]);
        glBindSampler(i, 0);
    }
    glActiveTexture(GL_TEXTURE0);
    if (texture_width != width || texture_height != height) {
        texture_width = width;
        texture_height = height;
        allocate_texture(texture, GL_RGB8, width, height, GL_RGB, NULL);
        allocate_texture(output_texture, GL_RGBA8, width, height, GL_RGBA, NULL);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, output_framebuffer);
        glFramebufferTexture2D(
            GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, output_texture, 0);
        if (glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
            failed = 1;
            WEB_BROWSER_REPORT({ tm4Port.antialiasingFailed = true; });
        }
    }
    glBindTexture(GL_TEXTURE_2D, texture);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer);
    glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, source[0] < source[2] ? source[0] : source[2],
        source[1] < source[3] ? source[1] : source[3], width, height);
    glViewport(0, 0, texture_width, texture_height);
    for (unsigned int i = 0; i < sizeof(capabilities) / sizeof(capabilities[0]); ++i) {
        capability_enabled[i] = glIsEnabled(capabilities[i]);
        glDisable(capabilities[i]);
    }
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glBindVertexArray(vertex_array);
    if (!failed && enabled == 2) {
        render_smaa();
    } else if (!failed) {
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, output_framebuffer);
        glUseProgram(program);
        bind_input(program, "frame", 0, texture);
        glDrawArrays(GL_TRIANGLES, 0, 3);
    }
    if (!failed) {
        if (clip_to_display)
            glEnable(GL_SCISSOR_TEST);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, output_framebuffer);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
        glBlitFramebuffer(source[0] < source[2] ? 0 : width, source[1] < source[3] ? 0 : height,
            source[0] < source[2] ? width : 0, source[1] < source[3] ? height : 0, destination[0],
            destination[1], destination[2], destination[3], GL_COLOR_BUFFER_BIT, GL_NEAREST);
    }
    glViewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    glBindVertexArray(previous_vao);
    glUseProgram(previous_program);
    glColorMask(color_mask[0], color_mask[1], color_mask[2], color_mask[3]);
    for (unsigned int i = 0; i < sizeof(capabilities) / sizeof(capabilities[0]); ++i)
        if (capability_enabled[i])
            glEnable(capabilities[i]);
    for (int i = 0; i < 3; ++i) {
        glActiveTexture(GL_TEXTURE0 + i);
        glBindTexture(GL_TEXTURE_2D, previous_texture[i]);
        glBindSampler(i, previous_sampler[i]);
    }
    glActiveTexture(active_texture);
    for (int i = 0; i < 4; ++i)
        glPixelStorei(unpack_names[i], unpack_values[i]);
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, unpack_buffer);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, read_fbo);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, draw_fbo);
    return !failed;
}
