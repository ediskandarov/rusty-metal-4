# Texture banks

Banked maps use these MR resources; the port does not identify individual mods.

| MR field | Type / value | Engine interpretation |
| --- | --- | --- |
| `world/textureBank` | Type 3, exactly 1,048,576 bytes | Independent 1024×512 bank of little-endian 16-bit PS1 VRAM words. |
| `world/textureBankOverlay` | Type 2 absolute registry path | Bitmap containing four `u16` values `x,y,w,h`, followed by exactly `w*h` pixel words. Must fit the bank. |
| `world/textures/reflchro`, `reflspec` | Type 3, exactly eight bytes | Reflection materials bound to the world's texture bank. |

Texture banks use a fixed renderer-owned pool: bank 0 is ordinary VRAM and banks
1–15 are independent layers. The pool reserves 30 MiB on the GPU and 17 MiB on the
CPU, including conversion scratch space. Releasing a bank makes its slot reusable;
only renderer shutdown releases the pool. Slots must outlive their drawing objects.

The world loader validates byte lengths and types before binding a bank. Overlays
are copied into private pixels, leaving MR data unchanged. Animation uploads temporarily
select the world's bank and restore the preceding upload target. Maps without
`textureBank` use ordinary VRAM.

The loader binds private copies of `world/displayPolys/shaderData` and `world/horiz.bin`.
Their existing packet layouts remain unchanged. A missing optional horizon or reflection
material retains the engine default. Releasing a map restores reflection bindings and
frees its runtime copies before its MR registration is removed.

Modules can create independent banks with `WebTextureBankCreate` and must release them
with `WebTextureBankDestroy` after deleting users. A zero create result means no bank
was allocated. Encode the returned ID as `((bank & 3) << 9) | ((bank & 12) << 10)` in each
material's texture page;
zero selects ordinary VRAM. Bank IDs are renderer resources, not snapshot state.

Texture bank IDs use tpage bits 9, 10, 12 and 13; bit 11 remains available for
the experimental upper car-atlas pages. Banks remain 1024×512 even when the
base VRAM is expanded to 1024×1024. Polygon-centering and transformed-sprite
flags travel in a separate vertex attribute, outside the texture-page bits.
