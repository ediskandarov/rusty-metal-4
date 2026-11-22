#include "texture_bank.h"

#ifdef TM4_STANDALONE
#include <stdio.h>
#include <stdlib.h>
static unsigned used, upload_target;
static void require_bank(unsigned bank)
{
    if (bank && (bank > 15 || !(used & (1u << (bank - 1))))) {
        fprintf(stderr, "Texture bank: invalid bank %u\n", bank);
        abort();
    }
}
unsigned WebTextureBankSelectUpload(unsigned bank)
{
    require_bank(bank);
    unsigned previous = upload_target;
    upload_target = bank;
    return previous;
}
int WebTextureBankCreate(const u16* pixels)
{
    if (!pixels)
        return 0;
    for (unsigned i = 0; i < 15; ++i)
        if (!(used & (1u << i))) {
            used |= 1u << i;
            return i + 1;
        }
    return 0;
}
void WebTextureBankDestroy(unsigned bank)
{
    require_bank(bank);
    if (bank)
        used &= ~(1u << (bank - 1));
    if (upload_target == bank)
        upload_target = 0;
}
#else
extern unsigned Rm4TextureBankSelectUpload(unsigned bank);
unsigned WebTextureBankSelectUpload(unsigned bank)
{
    return Rm4TextureBankSelectUpload(bank);
}
extern int Rm4TextureBankCreate(const u16* pixels);
extern void Rm4TextureBankDestroy(unsigned bank);
int WebTextureBankCreate(const u16* pixels)
{
    return Rm4TextureBankCreate(pixels);
}
void WebTextureBankDestroy(unsigned bank)
{
    Rm4TextureBankDestroy(bank);
}
#endif
