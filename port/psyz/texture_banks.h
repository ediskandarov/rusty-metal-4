#ifndef RUSTYMETAL_TEXTURE_BANKS_H
#define RUSTYMETAL_TEXTURE_BANKS_H

/* Included by the GL backend. The pool lives as long as the renderer: no texture
 * array reallocations or uploads of unrelated banks when a slot is reused. */
#define RM4_TEXTURE_BANK_LIMIT 15
#define RM4_TEXTURE_BANK_WORDS (VRAM_W * VRAM_H)
static GLuint rm4_texture_banks;
static u16* rm4_texture_bank_pixels;
static u8* rm4_texture_bank_rgba;
static unsigned rm4_texture_bank_used;
static unsigned rm4_texture_bank_upload_target;

static void Rm4TextureBankError(const char* reason)
{
    fprintf(stderr, "Texture bank: %s\n", reason);
    abort();
}

static void Rm4TextureBankCheckGl(void)
{
    GLenum error = glGetError();
    if (error != GL_NO_ERROR) {
        fprintf(stderr, "Texture bank GL error: 0x%x\n", (unsigned)error);
        abort();
    }
}

static int Rm4TextureBankValid(unsigned bank)
{
    return bank && bank <= RM4_TEXTURE_BANK_LIMIT && (rm4_texture_bank_used & (1u << (bank - 1)));
}

static void Rm4BindTextureBanks(void)
{
    glActiveTexture(GL_TEXTURE2);
    glBindTexture(GL_TEXTURE_2D_ARRAY, rm4_texture_banks);
    glActiveTexture(GL_TEXTURE0);
}

static void Rm4InitializeTextureBanks(void)
{
    if (rm4_texture_bank_pixels)
        Rm4TextureBankError("pool already initialized");
    rm4_texture_bank_pixels = malloc(RM4_TEXTURE_BANK_LIMIT * RM4_TEXTURE_BANK_WORDS * sizeof(u16));
    rm4_texture_bank_rgba = malloc(RM4_TEXTURE_BANK_WORDS * 4);
    if (!rm4_texture_bank_pixels || !rm4_texture_bank_rgba)
        Rm4TextureBankError("cannot allocate pool");
    glGenTextures(1, &rm4_texture_banks);
    Rm4BindTextureBanks();
    glActiveTexture(GL_TEXTURE2);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glTexImage3D(GL_TEXTURE_2D_ARRAY, 0, GL_RGBA8, VRAM_W, VRAM_H, RM4_TEXTURE_BANK_LIMIT, 0,
        GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glActiveTexture(GL_TEXTURE0);
    Rm4TextureBankCheckGl();
}

static void Rm4DestroyTextureBanks(void)
{
    glDeleteTextures(1, &rm4_texture_banks);
    rm4_texture_banks = 0;
    free(rm4_texture_bank_pixels);
    free(rm4_texture_bank_rgba);
    rm4_texture_bank_pixels = NULL;
    rm4_texture_bank_rgba = NULL;
    rm4_texture_bank_used = 0;
    rm4_texture_bank_upload_target = 0;
}

int Rm4TextureBankCreate(const u16* pixels)
{
    if (!rm4_texture_bank_pixels)
        Rm4TextureBankError("pool is not initialized");
    unsigned index;
    for (index = 0; index < RM4_TEXTURE_BANK_LIMIT; ++index)
        if (!(rm4_texture_bank_used & (1u << index)))
            break;
    if (index == RM4_TEXTURE_BANK_LIMIT || !pixels)
        return 0;
    Draw_FlushBuffer();
    memcpy(rm4_texture_bank_pixels + index * RM4_TEXTURE_BANK_WORDS, pixels,
        RM4_TEXTURE_BANK_WORDS * sizeof(u16));
    ConvertRgb5551ToRgba8888(pixels, rm4_texture_bank_rgba, RM4_TEXTURE_BANK_WORDS);
    glActiveTexture(GL_TEXTURE2);
    glBindTexture(GL_TEXTURE_2D_ARRAY, rm4_texture_banks);
    glTexSubImage3D(GL_TEXTURE_2D_ARRAY, 0, 0, 0, index, VRAM_W, VRAM_H, 1, GL_RGBA,
        GL_UNSIGNED_BYTE, rm4_texture_bank_rgba);
    glActiveTexture(GL_TEXTURE0);
    Rm4TextureBankCheckGl();
    rm4_texture_bank_used |= 1u << index;
    return index + 1;
}

void Rm4TextureBankDestroy(unsigned bank)
{
    if (!bank)
        return;
    if (!Rm4TextureBankValid(bank))
        Rm4TextureBankError("releasing an invalid bank");
    Draw_FlushBuffer();
    if (rm4_texture_bank_upload_target == bank)
        rm4_texture_bank_upload_target = 0;
    rm4_texture_bank_used &= ~(1u << (bank - 1));
}

unsigned Rm4TextureBankSelectUpload(unsigned bank)
{
    if (bank && !Rm4TextureBankValid(bank))
        Rm4TextureBankError("upload target is not a live bank");
    unsigned previous = rm4_texture_bank_upload_target;
    rm4_texture_bank_upload_target = bank;
    return previous;
}

static int Rm4TextureBankUpload(const PS1_RECT* rectangle, const u16* pixels)
{
    unsigned bank = rm4_texture_bank_upload_target;
    if (!bank)
        return 0;
    if (!Rm4TextureBankValid(bank) || !rectangle || !pixels || rectangle->x < 0 || rectangle->y < 0
        || rectangle->w <= 0 || rectangle->h <= 0 || rectangle->x + rectangle->w > VRAM_W
        || rectangle->y + rectangle->h > VRAM_H)
        Rm4TextureBankError("invalid upload rectangle or bank");
    size_t count = (size_t)rectangle->w * rectangle->h;
    Draw_FlushBuffer();
    u16* destination = rm4_texture_bank_pixels + (bank - 1) * RM4_TEXTURE_BANK_WORDS;
    for (int row = 0; row < rectangle->h; ++row)
        memcpy(destination + (rectangle->y + row) * VRAM_W + rectangle->x,
            pixels + row * rectangle->w, rectangle->w * sizeof(*pixels));
    ConvertRgb5551ToRgba8888(pixels, rm4_texture_bank_rgba, count);
    glActiveTexture(GL_TEXTURE2);
    glBindTexture(GL_TEXTURE_2D_ARRAY, rm4_texture_banks);
    glTexSubImage3D(GL_TEXTURE_2D_ARRAY, 0, rectangle->x, rectangle->y, bank - 1, rectangle->w,
        rectangle->h, 1, GL_RGBA, GL_UNSIGNED_BYTE, rm4_texture_bank_rgba);
    glActiveTexture(GL_TEXTURE0);
    Rm4TextureBankCheckGl();
    return 1;
}

#endif
