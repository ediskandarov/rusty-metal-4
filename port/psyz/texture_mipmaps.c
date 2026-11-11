#include "texture_mipmaps.h"

#include <SDL3/SDL.h>
#include <stdio.h>
#include <string.h>
#if defined(__EMSCRIPTEN__)
#include <GLES3/gl3.h>
#include <emscripten/html5_webgl.h>
#elif defined(_MSC_VER) || defined(__MINGW32__) || defined(__APPLE__)
#include "glad/glad.h"
#else
#include <GLES3/gl3.h>
#endif

#define MIP_CACHE_ENTRIES 256
#define MIP_CACHE_BYTES (64u * 1024u * 1024u)
#define TEXTURE_MAX_ANISOTROPY 0x84FE
#define MAX_TEXTURE_MAX_ANISOTROPY 0x84FF

static const char mip_vertex_shader[]
    = { "void main() {\n"
        "    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n"
        "    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n"
        "}\n" };

static const char mip_fragment_shader[]
    = { "uniform sampler2D sourceVram;\n"
        "uniform ivec2 origin;\n"
        "uniform uint page, clut, maskLayer;\n"
        "uniform uvec4 window;\n"
        "out vec4 decoded;\n"
        "uint word16(vec4 c) {\n"
        "    uvec4 bits = uvec4(c * vec4(31.0, 31.0, 31.0, 1.0) + 0.5);\n"
        "    return bits.r | (bits.g << 5u) | (bits.b << 10u) | (bits.a << 15u);\n"
        "}\n"
        "void main() {\n"
        "    uvec2 uv = (uvec2(origin + ivec2(gl_FragCoord.xy)) & window.xy) | window.zw;\n"
        "    ivec2 base = ivec2(int(page & 15u) * 64, int((page >> 4u) & 1u) * 256);\n"
        "    uint mode = (page >> 7u) & 3u;\n"
        "    vec4 color;\n"
        "    if (mode >= 2u) {\n"
        "        color = texelFetch(sourceVram, (base + ivec2(uv)) & ivec2(1023, 511), 0);\n"
        "    } else {\n"
        "        uint shift = mode == 0u ? 2u : 1u;\n"
        "        uint bits = mode == 0u ? 4u : 8u;\n"
        "        uint packed = word16(texelFetch(sourceVram,\n"
        "            (base + ivec2(uv.x >> shift, uv.y)) & ivec2(1023, 511), 0));\n"
        "        uint index = (packed >> ((uv.x & ((1u << shift) - 1u)) * bits)) & ((1u << bits) - "
        "1u);\n"
        "        ivec2 palette = ivec2(int(clut & 63u) * 16 + int(index), int(clut >> 6u));\n"
        "        color = texelFetch(sourceVram, palette & ivec2(1023, 511), 0);\n"
        "    }\n"
        "    bool covered = color != vec4(0.0) && uint(color.a + 0.5) == maskLayer;\n"
        "    decoded = covered ? vec4(color.rgb, 1.0) : vec4(0.0);\n"
        "}\n" };

typedef struct MipEntry {
    PsyzTextureView view;
    SDL_Rect texels, palette;
    GLuint texture;
    size_t bytes;
    uint64_t used;
    bool dirty, anisotropic;
} MipEntry;

static MipEntry entries[MIP_CACHE_ENTRIES];
static uint64_t clock_stamp;
static size_t allocated_bytes;
static GLuint program, framebuffer, vao;
static GLint source_uniform, origin_uniform, page_uniform, clut_uniform;
static GLint window_uniform, layer_uniform;
static bool failed;
static GLfloat max_anisotropy = 1.0f;

static bool SameView(const PsyzTextureView* a, const PsyzTextureView* b)
{
    return a->page == b->page && a->clut == b->clut && a->window == b->window && a->x == b->x
        && a->y == b->y && a->width == b->width && a->height == b->height;
}

static GLuint Compile(GLenum kind, const char* body, bool gles)
{
    const char* parts[] = { gles ? "#version 300 es\nprecision highp float;\nprecision highp int;\n"
                                 : "#version 330 core\n",
        body };
    GLuint shader = glCreateShader(kind);
    glShaderSource(shader, 2, parts, NULL);
    glCompileShader(shader);
    GLint ok;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[1024];
        glGetShaderInfoLog(shader, sizeof(log), NULL, log);
        fprintf(stderr, "Mipmap shader compilation failed: %s\n", log);
        glDeleteShader(shader);
        return 0;
    }
    return shader;
}

static bool Init(bool gles)
{
    GLuint vertex = Compile(GL_VERTEX_SHADER, mip_vertex_shader, gles);
    GLuint fragment = Compile(GL_FRAGMENT_SHADER, mip_fragment_shader, gles);
    GLint ok = 0;
    if (vertex && fragment) {
        program = glCreateProgram();
        glAttachShader(program, vertex);
        glAttachShader(program, fragment);
        glLinkProgram(program);
        glGetProgramiv(program, GL_LINK_STATUS, &ok);
    }
    if (vertex)
        glDeleteShader(vertex);
    if (fragment)
        glDeleteShader(fragment);
    if (!ok) {
        if (program)
            glDeleteProgram(program);
        program = 0;
        failed = true;
        fprintf(stderr, "Mipmap decoder unavailable; using bilinear filtering.\n");
        return false;
    }
    glGenFramebuffers(1, &framebuffer);
    glGenVertexArrays(1, &vao);
    source_uniform = glGetUniformLocation(program, "sourceVram");
    origin_uniform = glGetUniformLocation(program, "origin");
    page_uniform = glGetUniformLocation(program, "page");
    clut_uniform = glGetUniformLocation(program, "clut");
    window_uniform = glGetUniformLocation(program, "window");
    layer_uniform = glGetUniformLocation(program, "maskLayer");
#ifdef __EMSCRIPTEN__
    bool aniso = emscripten_webgl_enable_extension(
        emscripten_webgl_get_current_context(), "EXT_texture_filter_anisotropic");
#else
    bool aniso = SDL_GL_ExtensionSupported("GL_EXT_texture_filter_anisotropic")
        || SDL_GL_ExtensionSupported("GL_ARB_texture_filter_anisotropic");
#endif
    if (aniso)
        glGetFloatv(MAX_TEXTURE_MAX_ANISOTROPY, &max_anisotropy);
    if (max_anisotropy > 4.0f)
        max_anisotropy = 4.0f;
    return true;
}

static void DeleteEntry(MipEntry* entry)
{
    glDeleteTextures(1, &entry->texture);
    allocated_bytes -= entry->bytes;
    memset(entry, 0, sizeof(*entry));
}

static MipEntry* Oldest(void)
{
    MipEntry* oldest = &entries[0];
    for (int i = 0; i < MIP_CACHE_ENTRIES; i++) {
        if (!entries[i].texture)
            return &entries[i];
        if (entries[i].used < oldest->used)
            oldest = &entries[i];
    }
    return oldest;
}

static void SetDependencies(MipEntry* entry)
{
    const PsyzTextureView* v = &entry->view;
    int x0 = 255, y0 = 255, x1 = 0, y1 = 0;
    for (int x = v->x; x < v->x + v->width; x++) {
        int value = (x & (v->window & 255)) | ((v->window >> 16) & 255);
        if (value < x0)
            x0 = value;
        if (value > x1)
            x1 = value;
    }
    for (int y = v->y; y < v->y + v->height; y++) {
        int value = (y & ((v->window >> 8) & 255)) | ((v->window >> 24) & 255);
        if (value < y0)
            y0 = value;
        if (value > y1)
            y1 = value;
    }
    int mode = (v->page >> 7) & 3;
    int shift = mode < 2 ? 2 - mode : 0;
    entry->texels = (SDL_Rect) { (v->page & 15) * 64 + (x0 >> shift),
        ((v->page >> 4) & 1) * 256 + y0, (x1 >> shift) - (x0 >> shift) + 1, y1 - y0 + 1 };
    entry->palette = (SDL_Rect) { (v->clut & 63) * 16, v->clut >> 6,
        mode == 0       ? 16
            : mode == 1 ? 256
                        : 0,
        mode < 2 ? 1 : 0 };
    /* Wrapped sources are rare; invalidate conservatively instead of missing a write. */
    if (entry->texels.x + entry->texels.w > 1024 || entry->texels.y + entry->texels.h > 512)
        entry->texels = (SDL_Rect) { 0, 0, 1024, 512 };
    if (entry->palette.x + entry->palette.w > 1024 || entry->palette.y >= 512)
        entry->palette = (SDL_Rect) { 0, 0, 1024, 512 };
}

void PsyzMipmaps_Invalidate(int x, int y, int width, int height)
{
    if (!allocated_bytes)
        return;
    SDL_Rect changed = { x, y, width, height };
    for (int i = 0; i < MIP_CACHE_ENTRIES; i++) {
        MipEntry* entry = &entries[i];
        if (entry->texture
            && (SDL_HasRectIntersection(&changed, &entry->texels)
                || SDL_HasRectIntersection(&changed, &entry->palette)))
            entry->dirty = true;
    }
}

/* A miss runs a small GPU decode pass; no synchronous VRAM readback is needed. */
static bool Decode(MipEntry* entry, GLuint vram)
{
    GLint old_program, old_vao, old_read, old_draw, old_viewport[4], old_active;
    GLint old_texture, old_sampler;
    GLboolean old_mask[4];
    const GLenum capabilities[] = { GL_BLEND, GL_SCISSOR_TEST, GL_DEPTH_TEST, GL_STENCIL_TEST,
        GL_CULL_FACE, GL_DITHER, GL_RASTERIZER_DISCARD };
    GLboolean enabled[sizeof(capabilities) / sizeof(capabilities[0])];
    glGetIntegerv(GL_CURRENT_PROGRAM, &old_program);
    glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &old_vao);
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &old_read);
    glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &old_draw);
    glGetIntegerv(GL_VIEWPORT, old_viewport);
    glGetBooleanv(GL_COLOR_WRITEMASK, old_mask);
    glGetIntegerv(GL_ACTIVE_TEXTURE, &old_active);
    glActiveTexture(GL_TEXTURE0);
    glGetIntegerv(GL_TEXTURE_BINDING_2D, &old_texture);
    glGetIntegerv(GL_SAMPLER_BINDING, &old_sampler);
    glBindSampler(0, 0);
    glBindTexture(GL_TEXTURE_2D, vram);
    for (unsigned i = 0; i < sizeof(capabilities) / sizeof(capabilities[0]); i++) {
        enabled[i] = glIsEnabled(capabilities[i]);
        glDisable(capabilities[i]);
    }
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glBindVertexArray(vao);
    glUseProgram(program);
    const PsyzTextureView* v = &entry->view;
    glViewport(0, 0, v->width, v->height);
    glUniform1i(source_uniform, 0);
    glUniform2i(origin_uniform, v->x, v->y);
    glUniform1ui(page_uniform, v->page);
    glUniform1ui(clut_uniform, v->clut);
    glUniform4ui(window_uniform, v->window & 255, (v->window >> 8) & 255, (v->window >> 16) & 255,
        v->window >> 24);
    bool ok = true;
    for (int layer = 0; layer < 2; layer++) {
        glFramebufferTextureLayer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, entry->texture, 0, layer);
        if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
            ok = false;
            break;
        }
        glUniform1ui(layer_uniform, layer);
        glDrawArrays(GL_TRIANGLES, 0, 3);
    }
    glFramebufferTextureLayer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, 0, 0, 0);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, old_read);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, old_draw);
    glUseProgram(old_program);
    glBindVertexArray(old_vao);
    glViewport(old_viewport[0], old_viewport[1], old_viewport[2], old_viewport[3]);
    glColorMask(old_mask[0], old_mask[1], old_mask[2], old_mask[3]);
    for (unsigned i = 0; i < sizeof(capabilities) / sizeof(capabilities[0]); i++)
        if (enabled[i])
            glEnable(capabilities[i]);
    glBindTexture(GL_TEXTURE_2D, old_texture);
    glBindSampler(0, old_sampler);
    glActiveTexture(old_active);
    return ok;
}

unsigned PsyzMipmaps_Get(unsigned vram, bool gles, const PsyzTextureView* view, bool anisotropic)
{
    if (failed || view->width < 1 || view->height < 1 || view->width > 256 || view->height > 256
        || view->x < 0 || view->y < 0 || view->x + view->width > 256
        || view->y + view->height > 256)
        return 0;
    if (!program && !Init(gles))
        return 0;
    MipEntry* entry = NULL;
    for (int i = 0; i < MIP_CACHE_ENTRIES; i++)
        if (entries[i].texture && SameView(&entries[i].view, view)) {
            entry = &entries[i];
            break;
        }
    glActiveTexture(GL_TEXTURE2);
    if (!entry) {
        size_t bytes = 0;
        int levels = 0;
        for (int w = view->width, h = view->height;; w = w > 1 ? w / 2 : 1, h = h > 1 ? h / 2 : 1) {
            bytes += (size_t)w * h * 8;
            levels++;
            if (w == 1 && h == 1)
                break;
        }
        while (allocated_bytes + bytes > MIP_CACHE_BYTES) {
            MipEntry* oldest = NULL;
            for (int i = 0; i < MIP_CACHE_ENTRIES; i++)
                if (entries[i].texture && (!oldest || entries[i].used < oldest->used))
                    oldest = &entries[i];
            if (!oldest)
                break;
            DeleteEntry(oldest);
        }
        entry = Oldest();
        if (entry->texture)
            DeleteEntry(entry);
        entry->view = *view;
        entry->bytes = bytes;
        allocated_bytes += bytes;
        entry->dirty = true;
        SetDependencies(entry);
        glGenTextures(1, &entry->texture);
        glBindTexture(GL_TEXTURE_2D_ARRAY, entry->texture);
        glTexStorage3D(GL_TEXTURE_2D_ARRAY, levels, GL_RGBA8, view->width, view->height, 2);
        glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
        glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    } else {
        glBindTexture(GL_TEXTURE_2D_ARRAY, entry->texture);
    }
    entry->used = ++clock_stamp;
    if (max_anisotropy > 1.0f && entry->anisotropic != anisotropic) {
        glTexParameterf(
            GL_TEXTURE_2D_ARRAY, TEXTURE_MAX_ANISOTROPY, anisotropic ? max_anisotropy : 1.0f);
        entry->anisotropic = anisotropic;
    }
    if (entry->dirty) {
        if (!Decode(entry, vram)) {
            DeleteEntry(entry);
            failed = true;
        } else {
            glGenerateMipmap(GL_TEXTURE_2D_ARRAY);
            entry->dirty = false;
        }
    }
    glActiveTexture(GL_TEXTURE0);
    return entry->texture;
}

void PsyzMipmaps_Shutdown(void)
{
    for (int i = 0; i < MIP_CACHE_ENTRIES; i++)
        DeleteEntry(&entries[i]);
    glDeleteProgram(program);
    glDeleteFramebuffers(1, &framebuffer);
    glDeleteVertexArrays(1, &vao);
    program = framebuffer = vao = 0;
    clock_stamp = 0;
    failed = false;
    max_anisotropy = 1.0f;
}
