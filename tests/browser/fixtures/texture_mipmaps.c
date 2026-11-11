#include "texture_mipmaps.h"
#include <GLES3/gl3.h>
#include <emscripten.h>
#include <emscripten/html5_webgl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned char pixels[1024 * 512 * 4];
static GLuint vram, readback;
static int failures;
#define CHECK(test)                                                                                \
    do {                                                                                           \
        if (!(test)) {                                                                             \
            fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #test);                                \
            failures++;                                                                            \
        }                                                                                          \
    } while (0)

static void Pixel(int x, int y, unsigned r, unsigned g, unsigned b, unsigned a)
{
    unsigned char* p = pixels + (y * 1024 + x) * 4;
    p[0] = r;
    p[1] = g;
    p[2] = b;
    p[3] = a;
}

static void Word(int x, int y, unsigned word)
{
    Pixel(x, y, ((word & 31) * 255 + 15) / 31, (((word >> 5) & 31) * 255 + 15) / 31,
        (((word >> 10) & 31) * 255 + 15) / 31, (word & 0x8000) ? 255 : 0);
}

static void Upload(void)
{
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, vram);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 1024, 512, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    PsyzMipmaps_Invalidate(0, 0, 1024, 512);
}

static void Read(GLuint texture, int level, int layer, unsigned char* result)
{
    glBindFramebuffer(GL_FRAMEBUFFER, readback);
    glFramebufferTextureLayer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, texture, level, layer);
    CHECK(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE);
    glReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, result);
    glFramebufferTextureLayer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, 0, 0, 0);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
}

EMSCRIPTEN_KEEPALIVE int RunMipTests(void)
{
    EmscriptenWebGLContextAttributes attributes;
    emscripten_webgl_init_context_attributes(&attributes);
    attributes.majorVersion = 2;
    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context = emscripten_webgl_create_context("#test", &attributes);
    CHECK(context > 0);
    emscripten_webgl_make_context_current(context);
    glGenTextures(1, &vram);
    glBindTexture(GL_TEXTURE_2D, vram);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glGenFramebuffers(1, &readback);
    unsigned char color[4];
    for (int mode = 0; mode < 3; mode++) {
        memset(pixels, 0, sizeof(pixels));
        for (int y = 0; y < 8; y++)
            for (int x = 0; x < 8; x++) {
                if (mode == 0)
                    Word(x, y, 0x2121);
                else if (mode == 1)
                    Word(x, y, 0x0201);
                else
                    Pixel(x, y, (x & 1) ? 0 : 255, 0, (x & 1) ? 255 : 0, 0);
            }
        Pixel(1, 256, 255, 0, 0, 0);
        Pixel(2, 256, 0, 0, 255, 0);
        Upload();
        PsyzTextureView view = { mode << 7, 256 * 64, 0x0000ffff, 0, 0, 8, 8 };
        GLuint mip = PsyzMipmaps_Get(vram, true, &view, true);
        CHECK(mip != 0);
        Read(mip, 3, 0, color);
        CHECK(abs((int)color[0] - 128) <= 2 && color[1] == 0 && abs((int)color[2] - 128) <= 2
            && color[3] == 255);
        Read(mip, 3, 1, color);
        CHECK(color[0] == 0 && color[1] == 0 && color[2] == 0 && color[3] == 0);
        if (mode < 2) {
            /* The same page with another CLUT must not reuse the first decoded image. */
            Pixel(1, 257, 0, 255, 0, 0);
            Pixel(2, 257, 0, 255, 0, 0);
            Upload();
            PsyzTextureView other = view;
            other.clut += 64;
            GLuint second = PsyzMipmaps_Get(vram, true, &other, false);
            CHECK(second != mip);
            Read(second, 3, 0, color);
            CHECK(color[0] == 0 && color[1] == 255 && color[2] == 0);
            /* Animated palette changes invalidate an otherwise identical view. */
            Pixel(1, 256, 0, 255, 0, 0);
            Pixel(2, 256, 0, 255, 0, 0);
            glActiveTexture(GL_TEXTURE0);
            glBindTexture(GL_TEXTURE_2D, vram);
            glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 256, 1024, 1, GL_RGBA, GL_UNSIGNED_BYTE,
                pixels + 256 * 1024 * 4);
            PsyzMipmaps_Invalidate(0, 256, 1024, 1);
            CHECK(PsyzMipmaps_Get(vram, true, &view, false) == mip);
            Read(mip, 3, 0, color);
            CHECK(color[0] == 0 && color[1] == 255 && color[2] == 0);
        }
    }
    memset(pixels, 0, sizeof(pixels));
    for (int y = 0; y < 8; y++)
        for (int x = 0; x < 16; x++) {
            if (x >= 8)
                Pixel(x, y, 0, 255, 0, 0); /* Adjacent atlas tile. */
            else if (x % 4 == 0)
                Pixel(x, y, 255, 0, 0, 0);
            else if (x % 4 == 1)
                Pixel(x, y, 0, 0, 255, 255);
            /* Remaining texels are transparent black. */
        }
    Upload();
    PsyzTextureView view = { 0x100, 0, 0x0000ffff, 0, 0, 8, 8 };
    glEnable(GL_BLEND);
    glEnable(GL_SCISSOR_TEST);
    glEnable(GL_DITHER);
    glEnable(GL_CULL_FACE);
    glEnable(GL_DEPTH_TEST);
    glViewport(2, 3, 4, 5);
    glScissor(0, 0, 0, 0);
    glColorMask(GL_FALSE, GL_TRUE, GL_FALSE, GL_TRUE);
    GLuint mip = PsyzMipmaps_Get(vram, true, &view, false);
    GLint viewport[4];
    GLboolean mask[4];
    glGetIntegerv(GL_VIEWPORT, viewport);
    glGetBooleanv(GL_COLOR_WRITEMASK, mask);
    CHECK(viewport[0] == 2 && viewport[1] == 3 && viewport[2] == 4 && viewport[3] == 5);
    CHECK(!mask[0] && mask[1] && !mask[2] && mask[3]);
    CHECK(glIsEnabled(GL_BLEND) && glIsEnabled(GL_SCISSOR_TEST) && glIsEnabled(GL_DITHER)
        && glIsEnabled(GL_CULL_FACE) && glIsEnabled(GL_DEPTH_TEST));
    Read(mip, 3, 0, color);
    CHECK(abs((int)color[0] - 64) <= 2 && color[1] == 0 && color[2] == 0
        && abs((int)color[3] - 64) <= 2);
    Read(mip, 3, 1, color);
    CHECK(color[0] == 0 && color[1] == 0 && abs((int)color[2] - 64) <= 2
        && abs((int)color[3] - 64) <= 2);
    /* Texture writes also invalidate the view; unrelated writes do not. */
    for (int y = 0; y < 8; y++)
        for (int x = 0; x < 8; x++)
            Pixel(x, y, 255, 255, 0, 0);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, vram);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 1024, 8, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    PsyzMipmaps_Invalidate(500, 400, 8, 8);
    CHECK(PsyzMipmaps_Get(vram, true, &view, false) == mip);
    Read(mip, 3, 0, color);
    CHECK(abs((int)color[0] - 64) <= 2 && color[1] == 0);
    PsyzMipmaps_Invalidate(0, 0, 8, 8);
    CHECK(PsyzMipmaps_Get(vram, true, &view, false) == mip);
    Read(mip, 3, 0, color);
    CHECK(color[0] == 255 && color[1] == 255 && color[2] == 0 && color[3] == 255);
    for (int y = 0; y < 8; y++)
        for (int x = 0; x < 8; x++)
            Pixel(x, y, x % 4 == 0 ? 255 : 0, 0, x % 4 == 1 ? 255 : 0, x % 4 == 1 ? 255 : 0);
    Upload();
    /* Window offsets are resolved before downsampling. */
    view.window = 0x0008fff7;
    mip = PsyzMipmaps_Get(vram, true, &view, false);
    Read(mip, 3, 0, color);
    CHECK(color[0] == 0 && color[1] == 255 && color[2] == 0 && color[3] == 255);
    /* More entries than the cache capacity, then request an evicted view again. */
    for (int i = 0; i < 300; i++) {
        view.x = i % 128;
        view.y = i / 128;
        view.width = 4;
        view.height = 4;
        CHECK(PsyzMipmaps_Get(vram, true, &view, true) != 0);
    }
    view = (PsyzTextureView) { 0x100, 0, 0x0000ffff, 0, 0, 8, 8 };
    mip = PsyzMipmaps_Get(vram, true, &view, false);
    Read(mip, 3, 0, color);
    CHECK(abs((int)color[0] - 64) <= 2 && color[1] == 0 && color[2] == 0);
    CHECK(glGetError() == GL_NO_ERROR);
    PsyzMipmaps_Shutdown();
    CHECK(glGetError() == GL_NO_ERROR);
    glDeleteTextures(1, &vram);
    glDeleteFramebuffers(1, &readback);
    printf("Mipmap cache: %d failures\n", failures);
    return failures;
}
