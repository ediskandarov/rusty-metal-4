import struct

# Authored 5×7 lettering for the vehicle data card.
GLYPHS = {
    "A": (14, 17, 17, 31, 17, 17, 17),
    "B": (30, 17, 17, 30, 17, 17, 30),
    "C": (14, 17, 16, 16, 16, 17, 14),
    "D": (30, 17, 17, 17, 17, 17, 30),
    "E": (31, 16, 16, 30, 16, 16, 31),
    "F": (31, 16, 16, 30, 16, 16, 16),
    "G": (14, 17, 16, 23, 17, 17, 15),
    "H": (17, 17, 17, 31, 17, 17, 17),
    "I": (14, 4, 4, 4, 4, 4, 14),
    "J": (7, 2, 2, 2, 2, 18, 12),
    "K": (17, 18, 20, 24, 20, 18, 17),
    "L": (16, 16, 16, 16, 16, 16, 31),
    "M": (17, 27, 21, 21, 17, 17, 17),
    "N": (17, 25, 21, 19, 17, 17, 17),
    "O": (14, 17, 17, 17, 17, 17, 14),
    "P": (30, 17, 17, 30, 16, 16, 16),
    "Q": (14, 17, 17, 17, 21, 18, 13),
    "R": (30, 17, 17, 30, 20, 18, 17),
    "S": (15, 16, 16, 14, 1, 1, 30),
    "T": (31, 4, 4, 4, 4, 4, 4),
    "U": (17, 17, 17, 17, 17, 17, 14),
    "V": (17, 17, 17, 17, 17, 10, 4),
    "W": (17, 17, 17, 21, 21, 21, 10),
    "X": (17, 17, 10, 4, 10, 17, 17),
    "Y": (17, 17, 10, 4, 4, 4, 4),
    "Z": (31, 1, 2, 4, 8, 16, 31),
    "0": (14, 17, 19, 21, 25, 17, 14),
    "3": (30, 1, 1, 14, 1, 1, 30),
    "4": (2, 6, 10, 18, 31, 2, 2),
    "/": (1, 1, 2, 4, 8, 16, 16),
    ".": (0, 0, 0, 0, 0, 6, 6),
}


def character_info(car_pixels):
    width, height = 320, 240
    art_width, art_height = 210, 137
    art_x, art_y = 93, 57
    orange, cream, slate = (243, 135, 53), (231, 222, 194), (132, 142, 143)
    pixels = bytearray(width * height * 3)

    def rect(x, y, w, h, color):
        for row in range(y, y + h):
            start = (row * width + x) * 3
            pixels[start:start + w * 3] = bytes(color) * w

    def text(x, y, label, color, scale=1):
        for letter in label:
            if letter != " ":
                for row, bits in enumerate(GLYPHS[letter]):
                    for col in range(5):
                        if bits & (16 >> col):
                            rect(x + col * scale, y + row * scale, scale, scale, color)
            x += scale * 6

    rect(0, 0, width, height, (24, 27, 29))
    rect(12, 12, width - 24, height - 24, (36, 39, 39))
    rect(14, 14, width - 28, height - 28, (24, 27, 29))
    for row in range(art_height):
        start = ((row + art_y) * width + art_x) * 3
        pixels[start:start + art_width * 3] = car_pixels[
            row * art_width * 3:(row + 1) * art_width * 3
        ]
    rect(20, 54, 280, 2, orange)
    rect(20, 187, 280, 1, slate)
    text(20, 20, "EVELYN", orange, 4)
    text(219, 23, "GARAGE FILE", slate)
    text(219, 38, "RALLY SPEC", cream)
    text(20, 79, "DRIVETRAIN", slate)
    text(20, 92, "AWD", cream, 2)
    text(20, 117, "SPECIAL", slate)
    text(20, 130, "ION LANCE", orange)
    text(20, 151, "BOOST", slate)
    text(20, 164, "TWIN EXHAUST", cream)
    text(20, 195, "RALLY BRED. BUILT TO HOLD THE LINE.", cream)
    text(20, 207, "4 DOOR SEDAN", slate)

    words = [
        (pixels[i] >> 3) | ((pixels[i + 1] >> 3) << 5) | ((pixels[i + 2] >> 3) << 10)
        for i in range(0, len(pixels), 3)
    ]
    return struct.pack("<III4H", 0x10, 2, 12 + len(words) * 2, 0, 0, width, height) + (
        struct.pack(f"<{len(words)}H", *words)
    )
