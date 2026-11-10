#!/usr/bin/env python3
"""Author, export and render Evelyn using only the Python standard library."""

from __future__ import annotations
import argparse
import binascii
import json
import math
import random
import shutil
import struct
import zlib
from pathlib import Path

from info_card import character_info

ROOT = Path(__file__).resolve().parents[1]
SCALE = 80  # 203-unit wheelbase in the game
PALETTE = [
    (0, 0, 0),
    (24, 26, 28),
    (48, 48, 45),
    (77, 71, 59),
    (112, 53, 28),
    (168, 68, 25),
    (220, 92, 30),
    (245, 136, 51),
    (255, 192, 121),
    (135, 108, 53),
    (189, 151, 70),
    (231, 196, 111),
    (36, 54, 70),
    (108, 151, 172),
    (201, 211, 190),
    (222, 41, 34),
]
TILES = [
    "paint",
    "paint_dark",
    "hood",
    "glass",
    "rubber",
    "steel",
    "gold",
    "light",
    "grille",
    "tail",
    "plate",
    "vent",
    "gold_metal",
    "window_edge",
    "underbody",
    "patch",
]

REFLECTION = {
    "paint": 60,
    "paint_dark": 30,
    "glass": 96,
    "gold": 28,
    "gold_metal": 24,
    "steel": 10,
    "light": 14,
    "tail": 20,
}

BASE = [6, 5, 1, 12, 1, 2, 10, 14, 1, 15, 14, 1, 4, 1, 1, 3]


def png(path, w, h, pixels):
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", binascii.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\0" + bytes(pixels[y * w * 3 : (y + 1) * w * 3]) for y in range(h))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">2I5B", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def read_png(path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos = 8
    compressed = bytearray()
    palette = None
    while pos < len(data):
        size = struct.unpack_from(">I", data, pos)[0]
        tag = data[pos + 4 : pos + 8]
        block = data[pos + 8 : pos + 8 + size]
        pos += 12 + size
        if tag == b"IHDR":
            w, h, bits, mode, comp, filt, interlace = struct.unpack(">2I5B", block)
        elif tag == b"IDAT":
            compressed.extend(block)
        elif tag == b"PLTE":
            palette = [block[i : i + 3] for i in range(0, len(block), 3)]
        elif tag == b"tRNS":
            raise ValueError(
                "Transparent PNG (tRNS) is not supported; use an opaque atlas"
            )
    if (w, h) != (256, 64) or bits != 8 or mode not in (2, 3, 6) or interlace:
        raise ValueError(
            "Atlas must be a non-interlaced 256x64 8-bit RGB, RGBA or indexed PNG"
        )
    bpp = {2: 3, 3: 1, 6: 4}[mode]
    stride = w * bpp
    raw = zlib.decompress(compressed)
    prev = [0] * stride
    out = []
    for y in range(h):
        method = raw[y * (stride + 1)]
        row = list(raw[y * (stride + 1) + 1 : (y + 1) * (stride + 1)])
        for x in range(stride):
            a = row[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            q = a + b - c
            pa, pb, pc = abs(q - a), abs(q - b), abs(q - c)
            predictor = (
                0,
                a,
                b,
                (a + b) // 2,
                a if pa <= pb and pa <= pc else b if pb <= pc else c,
            )[method]
            row[x] = (row[x] + predictor) & 255
        for x in range(w):
            if mode == 6 and row[x * bpp + 3] != 255:
                raise ValueError(
                    "Nonopaque RGBA atlas pixels are not supported; use an opaque atlas"
                )
            out.append(
                tuple(palette[row[x]])
                if mode == 3
                else tuple(row[x * bpp : x * bpp + 3])
            )
        prev = row
    return out


def atlas():
    rng = random.Random(322)
    out = [0] * (256 * 64)
    for t, name in enumerate(TILES):
        ox, oy = (t % 8) * 32, (t // 8) * 32
        for y in range(32):
            for x in range(32):
                c = BASE[t]
                r = rng.random()
                if name in ("paint", "paint_dark"):
                    c = 6 if name == "paint" else 5
                    if name == "paint_dark" and y > 23 and r < 0.17:
                        c = 4 if y < 28 else 3
                    elif r < 0.003:
                        c = 7
                elif name == "hood":
                    c = 2 if x % 4 == 0 and y % 4 < 2 else 1
                elif name == "glass":
                    c = 12
                elif name == "rubber":
                    c = 2 if ((x + y // 3) % 8 < 2 and 3 < x < 28) else 1
                elif name == "steel":
                    c = 3 if y < 4 or x < 3 else 2
                    if r < 0.04:
                        c = 4
                    if x in (4, 27) and y in (4, 27):
                        c = 14
                elif name == "gold":
                    dx, dy = x - 15, y - 15
                    rad = math.hypot(dx, dy)
                    angle = math.atan2(dy, dx)
                    c = 1
                    if (
                        9.5 < rad < 11.8
                        or rad < 2.2
                        or (rad < 10 and abs(math.sin(angle * 3)) < 0.22)
                    ):
                        c = 11 if y < 12 else 10 if y < 23 else 9
                    if 12.5 < rad < 14.5:
                        c = 2
                elif name == "light":
                    rad = math.hypot(x - 15.5, y - 15.5)
                    c = 1
                    if 13 < rad < 15:
                        c = 2
                    lamp = math.hypot(x - 15, y - 11)
                    if lamp < 8.5:
                        c = 13 if lamp < 6.5 else 14
                    if lamp < 5 and y < 10:
                        c = 14
                    for cx in (9, 23):
                        lamp = math.hypot(x - cx, y - 23)
                        if lamp < 4:
                            c = 12 if lamp < 2.5 else 14
                elif name == "grille":
                    c = 3 if y % 5 == 0 else 1
                    if x % 8 == 0:
                        c = 2
                elif name == "tail":
                    if y < 4 or y > 27 or x < 3 or x > 28:
                        c = 1
                    elif y < 20:
                        c = 15
                    else:
                        c = 8 if x < 20 else 14
                    if y in (10, 15, 19):
                        c = 3
                elif name == "vent":
                    c = 2 if y % 6 in (0, 1) else 1
                elif name == "gold_metal":
                    c = 11 if y < 10 else 10 if y < 23 else 9
                    if r < 0.03:
                        c = 3
                elif name == "patch":
                    c = 2 if y in (2, 29) or x in (2, 29) else 3
                    if x in (4, 27) and y in (4, 27):
                        c = 14
                out[(oy + y) * 256 + ox + x] = c
    # Hand drawn 3x5 lettering, original pixel artwork.
    font = {
        "E": ["111", "100", "110", "100", "111"],
        "V": ["101", "101", "101", "101", "010"],
        "3": ["111", "001", "111", "001", "111"],
        "L": ["100", "100", "100", "100", "111"],
        "1": ["010", "110", "010", "010", "111"],
        "N": ["101", "111", "111", "111", "101"],
    }
    ox, oy = 64, 32
    for y in range(32):
        for x in range(32):
            out[(oy + y) * 256 + ox + x] = 14 if 2 < x < 29 and 7 < y < 24 else 1
    for i, ch in enumerate("EV3L1N"):
        for y, row in enumerate(font[ch]):
            for x, b in enumerate(row):
                if b == "1":
                    for dy in range(2):
                        out[(oy + 11 + y * 2 + dy) * 256 + ox + 4 + i * 4 + x] = 1
    # Relocate headlamp art, then dedicate the last 64 columns to a larger wheel disc.
    for y in range(32):
        for x in range(32):
            out[(y + 32) * 256 + 128 + x] = out[y * 256 + 224 + x]
    for y in range(64):
        for x in range(64):
            dx, dy = x - 31.5, y - 31.5
            rad = math.hypot(dx, dy)
            a = math.atan2(dy, dx)
            c = 1
            if 27 < rad < 30:
                c = 2
            if 21 < rad < 24 or rad < 4 or (rad < 22 and abs(math.sin(a * 3)) < 0.15):
                c = 11 if y < 22 else 10 if y < 46 else 9
            if 23 < rad < 24:
                c = 11
            out[y * 256 + 192 + x] = c
    return out


ATLAS = atlas()


def uv_tile(name):
    if name == "gold":
        return [[193, 1], [254, 1], [254, 62], [193, 62]]
    aliases = {"light": "gold_metal", "underbody": "window_edge", "patch": "steel"}
    i = TILES.index(aliases.get(name, name))
    x, y = (i % 8) * 32, (i // 8) * 32
    return [[x + 1, y + 1], [x + 30, y + 1], [x + 30, y + 30], [x + 1, y + 30]]


def sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def unit(a):
    d = math.sqrt(dot(a, a))
    return tuple(x / d for x in a) if d else (0, 1, 0)


class Mesh:
    def __init__(self, name, pivot=(0, 0, 0), wheel=False):
        self.name, self.pivot, self.wheel = name, pivot, wheel
        self.vertices = []
        self.faces = []

    def face(self, points, material="paint", outward=None, uv=None):
        points = list(points)
        normal = unit(cross(sub(points[1], points[0]), sub(points[2], points[0])))
        if outward is not None and dot(normal, outward) < 0:
            points.reverse()
            if uv is not None:
                uv = uv[::-1]
            normal = tuple(-x for x in normal)
        indices = []
        for p in points:
            p = tuple(round(x, 5) for x in p)
            if p not in self.vertices:
                self.vertices.append(p)
            indices.append(self.vertices.index(p))
        if uv is None and material == "paint_dark":
            uv = uv_tile(material)[: len(points)]
            uv = [
                [t[0], max(1, min(30, round((0.58 - p[1]) / 0.35 * 29 + 1)))]
                for p, t in zip(points, uv)
            ]
        self.faces.append(
            {
                "v": indices,
                "material": material,
                "uv": (uv or uv_tile(material))[: len(points)],
                "normal": normal,
            }
        )

    def box(self, lo, hi, material="steel"):
        x, y, z = lo
        X, Y, Z = hi
        for ps, n in [
            ([(x, y, z), (X, y, z), (X, Y, z), (x, Y, z)], (0, 0, -1)),
            ([(x, y, Z), (X, y, Z), (X, Y, Z), (x, Y, Z)], (0, 0, 1)),
            ([(x, y, z), (x, y, Z), (x, Y, Z), (x, Y, z)], (-1, 0, 0)),
            ([(X, y, z), (X, y, Z), (X, Y, Z), (X, Y, z)], (1, 0, 0)),
            ([(x, Y, z), (X, Y, z), (X, Y, Z), (x, Y, Z)], (0, 1, 0)),
            ([(x, y, z), (X, y, z), (X, y, Z), (x, y, Z)], (0, -1, 0)),
        ]:
            self.face(ps, material, n)

    def data(self):
        smooth = self.name.startswith(("body_", "front_", "rear_", "cabin_")) or self.name in (
            "hood",
            "roof",
            "windscreens",
            "trunk",
            "front_bumper",
            "rear_bumper",
        )
        vertex_normals = []
        for i in range(len(self.vertices)):
            adjacent = [f["normal"] for f in self.faces if i in f["v"]]
            vertex_normals.append(
                unit(tuple(sum(n[j] for n in adjacent) for j in range(3)))
            )
        return {
            "name": self.name,
            "pivot": self.pivot,
            "wheel": self.wheel,
            "vertices": self.vertices,
            "faces": self.faces,
            "smooth": smooth,
            "vertex_normals": vertex_normals,
        }


def author(distant=False):
    groups = []

    def group(n, p=(0, 0, 0), wheel=False):
        m = Mesh(n, p, wheel)
        groups.append(m)
        return m

    exhaust_x, exhaust_y, exhaust_z = 0.53, 0.295, -2.312

    def bumper_depth(col, depth):
        return depth - max(0, abs(col) - 0.5) / 0.5 * (depth - 2.02)

    def lerp_table(z, table):
        for (a, va), (b, vb) in zip(table, table[1:]):
            if a <= z <= b:
                return va + (vb - va) * (z - a) / (b - a)
        return table[0][1] if z < table[0][0] else table[-1][1]

    def shoulder(z):
        return lerp_table(
            z,
            [
                (-2.2, 0.75),
                (-2.02, 0.80),
                (-1.85, 0.85),
                (-1.28, 0.91),
                (-0.6, 0.93),
                (0.65, 0.94),
                (1.26, 0.88),
                (1.85, 0.83),
                (2.02, 0.80),
                (2.2, 0.75),
            ],
        )

    def breadth(z):
        return lerp_table(
            z,
            [
                (-2.2, 0.69),
                (-2.02, 0.77),
                (-1.92, 0.81),
                (-1.28, 0.85),
                (-0.6, 0.83),
                (0.6, 0.83),
                (1.26, 0.85),
                (1.85, 0.81),
                (2.02, 0.77),
                (2.2, 0.67),
            ],
        )

    def arch(z):
        for c in (-1.28, 1.26):
            if abs(z - c) < 0.37:
                return 0.32 + math.sqrt(0.37**2 - (z - c) ** 2)
        return 0.23

    zs = [-2.02, -1.65, -1.28, -0.91, 0.12, 0.89, 1.26, 1.63, 2.02]
    if distant:
        zs.remove(0.12)
    for side, label in [(-1, "left"), (1, "right")]:

        def row(z, i):
            bottom = arch(z)
            top = shoulder(z)
            mid = max(bottom, min(0.57, top - 0.09))
            w = breadth(z)
            if i == 0:
                return (side * (w - 0.07), bottom, z)
            if i == 1:
                return (side * (w + 0.025), mid, z)
            if i == 2:
                return (side * (w - 0.025), top, z)
            return (side * (w - 0.075), top + 0.065, z)

        for i, (a, b) in enumerate(zip(zs, zs[1:])):
            if i in (0, 4):
                m = group(f"body_{label}_{i}")
            for j in range(3):
                if j == 0 and min(arch(a), arch(b)) >= 0.57:
                    continue
                ps = [row(a, j), row(b, j), row(b, j + 1), row(a, j + 1)]
                if max(p[1] for p in ps) - min(p[1] for p in ps) < 0.015:
                    continue
                m.face(ps, "paint" if j else "paint_dark", (side, 0, 0))
        # Arched four-door greenhouse. B pillar sits just behind the driver's seat.
        m = group("cabin_" + label)
        outline = [
            (0.73, 0.98),
            (0.43, 1.22),
            (0.15, 1.40),
            (-0.12, 1.46),
            (-0.70, 1.44),
            (-0.94, 1.33),
            (-1.20, 1.13),
            (-1.46, 0.98),
        ]

        # Coordinates above are Z,Y; tuck roof shoulders inward, instead of flat slab sides.
        def cab(z, y):
            width = lerp_table(z, [
                (-1.46, 0.77), (-1.20, 0.71), (-0.94, 0.66),
                (-0.70, 0.63), (-0.12, 0.62), (0.15, 0.64), (0.43, 0.69), (0.73, 0.755),
            ])
            roof_height = lerp_table(z, sorted(outline))
            width += (roof_height - y) * 0.27
            return (side * width, y, z)

        for i in range(len(outline) - 1):
            a, b = outline[i], outline[i + 1]
            m.face(
                [cab(a[0], 0.975), cab(b[0], 0.975), cab(*b), cab(*a)],
                "paint",
                (side, 0, 0),
            )
        # Glazing follows the curved roof edge and leaves narrow A/B/C pillars.
        windows = [
            [
                (0.61, 1.02),
                (0.37, 1.23),
                (0.10, 1.36),
                (-0.10, 1.40),
                (-0.19, 1.40),
                (-0.19, 1.02),
            ],
            [(-0.27, 1.02), (-0.27, 1.40), (-0.68, 1.38), (-0.88, 1.28), (-1.29, 1.02)],
        ]
        for window in windows:
            ps = [cab(z, y) for z, y in window]
            ps = [(p[0] + side * 0.015, p[1], p[2]) for p in ps]
            # Convex window fans split into triangles; dedicated UV shading keeps them coherent.
            for i in range(1, len(ps) - 1, 2):
                m.face([ps[0], *ps[i:i + 3]], "glass", (side, 0, 0))
        # Door outlines and handles make the two doors legible without texture noise.
        m = group("door_details_" + label)
        for z in (-0.24, 0.64):
            w = breadth(z)
            m.face([
                (side * (w + 0.031), 0.56, z),
                (side * (w + 0.031), 0.56, z + 0.016),
                (side * (w - 0.020), shoulder(z), z + 0.016),
                (side * (w - 0.020), shoulder(z), z),
            ], "window_edge", (side, 0, 0))
        for z in (-0.08, -0.95):
            m.face(
                [
                    (side * (breadth(z) + 0.02), 0.86, z - 0.08),
                    (side * (breadth(z) + 0.02), 0.86, z + 0.06),
                    (side * (breadth(z) + 0.02), 0.90, z + 0.06),
                    (side * (breadth(z) + 0.02), 0.90, z - 0.08),
                ],
                "paint_dark",
                (side, 0, 0),
            )
    # Curved hood: two longitudinal breaks and a raised center across its width.
    hood = m = group("hood")
    hr = [
        (2.15, 0.865, 0.695),
        (1.75, 0.91, 0.735),
        (1.12, 0.96, 0.77),
        (0.73, 0.98, 0.755),
    ]
    for (za, ya, wa), (zb, yb, wb) in zip(hr, hr[1:]):
        columns = [(-1, -0.5), (-0.5, 0), (0, 0.5), (0.5, 1)]
        for a, b in columns:
            m.face(
                [
                    (
                        wa * a,
                        ya + (0.035 if a == 0 and za != 2.15 else 0),
                        bumper_depth(a, za) if za == 2.15 else za,
                    ),
                    (
                        wa * b,
                        ya + (0.035 if b == 0 and za != 2.15 else 0),
                        bumper_depth(b, za) if za == 2.15 else za,
                    ),
                    (wb * b, yb + (0.035 if b == 0 else 0), zb),
                    (wb * a, yb + (0.035 if a == 0 else 0), zb),
                ],
                "paint",
                (0, 1, 0),
            )
    # Crown the roof both lengthwise and across its width.
    m = group("roof")
    rr = [
        (0.15, 1.40, 0.64),
        (-0.12, 1.46, 0.62),
        (-0.70, 1.44, 0.63),
        (-0.94, 1.33, 0.66),
    ]
    for (za, ya, wa), (zb, yb, wb) in zip(rr, rr[1:]):
        for a, b in [(-1, 0), (0, 1)]:
            m.face(
                [
                    (wa * a, ya + (0.035 if a == 0 else 0), za),
                    (wa * b, ya + (0.035 if b == 0 else 0), za),
                    (wb * b, yb + (0.035 if b == 0 else 0), zb),
                    (wb * a, yb + (0.035 if a == 0 else 0), zb),
                ],
                "paint",
                (0, 1, 0),
            )
    m = group("windscreens")
    for rings in [
        [(0.73, 0.98, 0.755), (0.43, 1.22, 0.69), (0.15, 1.40, 0.64)],
        [(-0.94, 1.33, 0.66), (-1.20, 1.13, 0.71), (-1.46, 0.98, 0.77)],
    ]:
        for (za, ya, wa), (zb, yb, wb) in zip(rings, rings[1:]):
            for a, b in [(-1, 0), (0, 1)]:
                m.face(
                    [
                        (wa * a, ya + (0.025 if a == 0 else 0), za),
                        (wa * b, ya + (0.025 if b == 0 else 0), za),
                        (wb * b, yb + (0.025 if b == 0 else 0), zb),
                        (wb * a, yb + (0.025 if a == 0 else 0), zb),
                    ],
                    "glass",
                    (0, 1, 1 if za > 0 else -1),
                )
    m = group("trunk")
    for (za, ya, wa), (zb, yb, wb) in zip(
        [(-1.46, 0.98, 0.77), (-1.85, 0.94, 0.74), (-2.15, 0.865, 0.695)],
        [(-1.85, 0.94, 0.74), (-2.15, 0.865, 0.695)],
    ):
        columns = [(-1, -0.5), (-0.5, 0), (0, 0.5), (0.5, 1)]
        for a, b in columns:
            m.face(
                [
                    (wa * a, ya + (0.025 if a == 0 else 0), za),
                    (wa * b, ya + (0.025 if b == 0 else 0), za),
                    (
                        wb * b,
                        yb + (0.025 if b == 0 and zb != -2.15 else 0),
                        -bumper_depth(b, -zb) if zb == -2.15 else zb,
                    ),
                    (
                        wb * a,
                        yb + (0.025 if a == 0 and zb != -2.15 else 0),
                        -bumper_depth(a, -zb) if zb == -2.15 else zb,
                    ),
                ],
                "paint",
                (0, 1, 0),
            )
    # Wrap the face of each bumper into the fenders. The recesses are cuts in the panel.
    front_rows = [
        (0.23, 0.76, 2.18), (0.53, 0.80, 2.26),
        (0.59, 0.80, 2.24), (0.81, 0.74, 2.20), (0.865, 0.695, 2.15),
    ]
    rear_rows = [
        (0.23, 0.75, 2.19), (0.50, 0.78, 2.25),
        (0.58, 0.78, 2.23), (0.79, 0.75, 2.22), (0.865, 0.695, 2.15),
    ]
    # Only the lamp row needs the extra break at ±0.80. On the other rows
    # the outer sections are coplanar and use the same paint.
    painted_columns = (-1, -0.5, 0.5, 1)
    lamp_columns = (-1, -0.80, -0.5, 0.5, 0.80, 1)

    def fascia_point(row, col, sign):
        y, width, depth = row
        return (width * col, y, sign * bumper_depth(col, depth))

    for label, sign, rows in [("front", 1, front_rows), ("rear", -1, rear_rows)]:
        m = group(label + "_bumper")
        for i, (low, high) in enumerate(zip(rows, rows[1:])):
            columns = lamp_columns if i == 2 else painted_columns
            for j, (a, b) in enumerate(zip(columns, columns[1:])):
                material = "paint_dark" if i == 0 else "paint"
                center = a == -0.5 and b == 0.5
                if i == 0 and center and sign == 1:
                    material = "grille"
                if i == 2 and center:
                    material = "grille" if sign == 1 else "window_edge"
                if i == 2 and j in (1, 3):
                    material = "light" if sign == 1 else "tail"
                if i == 1 and sign == -1 and center:
                    material = "plate"
                ps = [
                    fascia_point(low, a, sign), fascia_point(low, b, sign),
                    fascia_point(high, b, sign), fascia_point(high, a, sign),
                ]
                uv = uv_tile(material)
                if material in ("tail", "light", "plate"):
                    u0, v0 = uv[0]
                    u1, v1 = uv[2]
                    uv = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]]
                    if sign < 0:
                        uv = [[u0 + u1 - u, v] for u, v in uv]
                m.face(ps, material, (0, 0, sign), uv=uv)
        # Rounded corners close the seams between the bumper and side skins.
        for side in (-1, 1):
            w = breadth(2.02 * sign)
            top = shoulder(2.02 * sign)
            m.face(
                [(side * (w - 0.07), 0.23, sign * 2.02),
                 (side * (w + 0.025), 0.57, sign * 2.02),
                 (side * rows[2][1], rows[2][0], sign * 2.02),
                 (side * rows[0][1], rows[0][0], sign * 2.02)],
                "paint_dark", (side, 0, 0),
            )
            m.face(
                [(side * (w + 0.025), 0.57, sign * 2.02),
                 (side * (w - 0.025), top, sign * 2.02),
                 (side * rows[-1][1], rows[-1][0], sign * 2.02),
                 (side * rows[2][1], rows[2][0], sign * 2.02)],
                "paint", (side, 0, 0),
            )
    for side, label in [(-1, "left"), (1, "right")]:
        m = group("exhaust_" + label)
        x, y, z = side * exhaust_x, exhaust_y, exhaust_z
        opening = [(x - 0.069, y - 0.063, z), (x + 0.069, y - 0.063, z),
                   (x + 0.069, y + 0.063, z), (x - 0.069, y + 0.063, z)]
        back = [(x + (p[0] - x) * 1.15, y + (p[1] - y) * 1.15, z + 0.19) for p in opening]
        for i, normal in enumerate(((0, -1, 0), (1, 0, 0), (0, 1, 0), (-1, 0, 0))):
            j = (i + 1) % 4
            m.face([opening[i], opening[j], back[j], back[i]], "steel", normal)
        m.face(opening, "underbody", (0, 0, -1))
    m = group("underbody")

    def floor_edge(z, side):
        return (side * (breadth(z) - 0.07), arch(z), z)

    # Close the floor against the existing rocker profile. At the wheel
    # openings the panel rises inside the arch and leaves the tire clear.
    floor_stations = [z for z in zs if z != 0.12]
    for a, b in zip(floor_stations, floor_stations[1:]):
        m.face(
            [floor_edge(a, -1), floor_edge(a, 1), floor_edge(b, 1), floor_edge(b, -1)],
            "underbody", (0, -1, 0),
        )
    for sign, row in [(-1, rear_rows[0]), (1, front_rows[0])]:
        a, b, c, d = [fascia_point(row, col, sign) for col in painted_columns]
        middle = (0, row[0], sign * 2.02)
        for points in ([a, b, middle], [middle, b, c], [middle, c, d]):
            m.face(points, "underbody", (0, -1, 0))
    # Rim/spoke art is mapped across each complete outer tire wall.
    wheel_segments = 8
    for name, x, z in [
        ("fl_wheel", -0.76, 1.26),
        ("fr_wheel", 0.76, 1.26),
        ("rr_wheel", 0.76, -1.28),
        ("rl_wheel", -0.76, -1.28),
    ]:
        m = group(name, (x, 0.32, z), True)
        side = 1 if x > 0 else -1
        for i in range(wheel_segments):
            a, b = i * math.tau / wheel_segments, (i + 1) * math.tau / wheel_segments
            m.face(
                [
                    (-0.10, 0.32 * math.sin(a), 0.32 * math.cos(a)),
                    (-0.10, 0.32 * math.sin(b), 0.32 * math.cos(b)),
                    (0.10, 0.32 * math.sin(b), 0.32 * math.cos(b)),
                    (0.10, 0.32 * math.sin(a), 0.32 * math.cos(a)),
                ],
                "rubber",
                (0, math.sin((a + b) / 2), math.cos((a + b) / 2)),
            )
        for s in (-1, 1):
            ring = [
                (
                    s * 0.10,
                    0.32 * math.sin(i * math.tau / wheel_segments),
                    0.32 * math.cos(i * math.tau / wheel_segments),
                )
                for i in range(wheel_segments)
            ]
            for i in range(1, wheel_segments - 1, 2):
                ps = [ring[j] for j in (0, i, i + 1, i + 2)]
                uv = [
                    [223 + round(p[2] / 0.32 * 29), 31 - round(p[1] / 0.32 * 29)]
                    for p in ps
                ]
                if (
                    dot(unit(cross(sub(ps[1], ps[0]), sub(ps[2], ps[0]))), (s, 0, 0))
                    < 0
                ):
                    ps.reverse()
                    uv.reverse()
                m.face(
                    ps,
                    "gold" if s == side else "underbody",
                    uv=uv if s == side else None,
                )
    m = group("wing")
    for x in (-0.70, 0.70):
        m.face([(x, 0.93, -2.00), (x, 0.93, -1.76), (x, 1.17, -1.86),
                (x, 1.17, -1.99)], "paint", (1, 0, 0))
    m.box((-0.80, 1.15, -2.01), (0.80, 1.20, -1.77), "paint")
    for side, label in [(-1, "left"), (1, "right")]:
        m = group("fender_gun_" + label)
        x = side * 0.89
        tip = [(x - 0.035, 0.915, 1.72), (x + 0.035, 0.915, 1.72), (x, 0.972, 1.72)]
        root = [(side * 0.78, 0.88, 0.77), (side * 0.94, 0.88, 0.77), (x, 1.025, 0.77)]
        if side < 0:
            root[0], root[1] = root[1], root[0]
        for i, normal in enumerate(((0, -1, 0), (1, 1, 0), (-1, 1, 0))):
            j = (i + 1) % 3
            m.face([root[i], root[j], tip[j], tip[i]], "steel", normal)
        m.face(tip, "underbody", (0, 0, 1))
        m = group("mirror_" + label)
        inner = [
            (side * 0.82, 1.01, 0.60),
            (side * 0.82, 1.11, 0.54),
            (side * 0.82, 1.02, 0.43),
        ]
        outer = [
            (side * 0.96, 1.015, 0.57),
            (side * 0.96, 1.08, 0.53),
            (side * 0.96, 1.02, 0.45),
        ]
        m.face(inner, "paint", (-side, 0, 0))
        m.face(outer, "paint", (side, 0, 0))
        for i in range(3):
            m.face(
                [inner[i], outer[i], outer[(i + 1) % 3], inner[(i + 1) % 3]],
                "glass" if i == 2 else "paint",
                [(0, 0, 1), (0, 1, 0), (0, 0, -1)][i],
            )
    if not distant:
        # Keep the scoop and vents with the bonnet so their order stays fixed
        # as the group order changes during rotation.
        m = hood
        scoop_base = [(-0.23, 0.98, 1.10), (0.23, 0.98, 1.10),
                      (0.20, 0.97, 1.48), (-0.20, 0.97, 1.48)]
        scoop_lip = [(-0.19, 1.05, 1.12), (0.19, 1.05, 1.12),
                     (0.15, 1.08, 1.48), (-0.15, 1.08, 1.48)]
        m.face(scoop_lip, "paint", (0, 1, 0))
        for i, direction in enumerate([(0, 0, -1), (1, 0, 0), (0, 0, 1), (-1, 0, 0)]):
            j = (i + 1) % 4
            m.face([scoop_base[i], scoop_base[j], scoop_lip[j], scoop_lip[i]],
                   "grille" if i == 2 else "paint_dark", direction)
        for side in (-1, 1):
            a, b = sorted((side * 0.20, side * 0.49))
            m.face(
                [(a, 0.982, 1.20), (b, 0.982, 1.20), (b, 0.95, 1.61), (a, 0.95, 1.61)],
                "vent",
                (0, 1, 0),
            )
    for side, label in [(-1, "left"), (1, "right")]:
        m = group("sill_" + label)
        m.face([(side * 0.80, 0.19, -0.88), (side * 0.80, 0.19, 0.86),
                (side * 0.817, 0.29, 0.86), (side * 0.817, 0.29, -0.88)],
               "window_edge", (side, 0, 0))
    if distant:
        detail_prefixes = ("door_details_", "fender_gun_", "mirror_", "hood_",
                           "sill_", "exhaust_")
        return [g.data() for g in groups if not g.name.startswith(detail_prefixes)]
    return {
        "name": "Evelyn",
        "units": "meters",
        "axes": "X right, Y up, Z forward; export X right, Y down, Z forward",
        "units_per_meter": SCALE,
        "budget": {"visible_faces": 262, "padded_group_vertices": 566},
        "groups": [g.data() for g in groups],
        "distant_groups": author(distant=True),
        "attachments": {
            "machine_gun_left": {
                "position": [-0.89, 0.94, 1.72],
                "direction": [0, 0, 1],
            },
            "machine_gun_right": {
                "position": [0.89, 0.94, 1.72],
                "direction": [0, 0, 1],
            },
            "special_launcher": {
                "position": [0, 1.00, 2.19],
                "direction": [0, 0, 1],
            },
            "turbo_left": {"position": [-exhaust_x, exhaust_y, exhaust_z], "direction": [0, 0, -1]},
            "turbo_right": {"position": [exhaust_x, exhaust_y, exhaust_z], "direction": [0, 0, -1]},
        },
    }


def game(v):
    return [round(v[0] * SCALE), round(-v[1] * SCALE), round(v[2] * SCALE)]


def write_obj(model):
    lines = [
        "# Original Evelyn mesh; meters, Y up, Z forward",
        "mtllib evelyn.mtl",
        "s off",
    ]
    vi = 1
    ti = 1
    normal_index = 1
    for g in model["groups"]:
        lines.append("o " + g["name"])
        for p in g["vertices"]:
            lines.append("v " + " ".join(f"{v:.5f}" for v in add(p, g["pivot"])))
        lines.append("usemtl atlas")
        for f in g["faces"]:
            for u, v in f["uv"]:
                lines.append(f"vt {(u + 0.5) / 256:.7f} {1 - (v + 0.5) / 64:.7f}")
            for k in f["v"]:
                n = g["vertex_normals"][k] if g.get("smooth") else f["normal"]
                lines.append("vn " + " ".join(f"{v:.7f}" for v in n))
            lines.append(
                "f "
                + " ".join(
                    f"{vi + k}/{ti + i}/{normal_index + i}"
                    for i, k in enumerate(f["v"])
                )
            )
            ti += len(f["v"])
            normal_index += len(f["v"])
        vi += len(g["vertices"])
    (ROOT / "source/evelyn.obj").write_text("\n".join(lines) + "\n")
    (ROOT / "source/evelyn.mtl").write_text(
        "newmtl atlas\nKa 0.35 0.35 0.35\nKd 1 1 1\nKs 0 0 0\nd 1\nillum 1\nmap_Kd atlas.png\n"
    )


def pack_mr(entries):
    tree = {"files": {}, "dirs": {}}
    for path, (kind, count, data) in entries.items():
        node = tree
        parts = path.split("/")
        for p in parts[:-1]:
            node = node["dirs"].setdefault(p, {"files": {}, "dirs": {}})
        node["files"][parts[-1]] = (kind, count, data)

    def name(s):
        b = s.encode("ascii") + b"\0"
        return b + b"\0" * ((-len(b)) % 4)

    def folder(n, node):
        nm = name(n)
        out = bytearray(
            struct.pack("<BBH", len(nm), len(node["dirs"]), len(node["files"])) + nm
        )
        for k, (kind, count, data) in sorted(node["files"].items()):
            nm = name(k)
            data += b"\0" * ((-len(data)) % 4)
            out.extend(
                struct.pack("<BBHII", len(nm), kind, count, len(data), 0) + nm + data
            )
        for k, child in sorted(node["dirs"].items()):
            out.extend(folder(k, child))
        return out

    return b"\x67\0\0\0" + folder("Root", tree)


def validate_authoring_options(model):
    if model.get("units_per_meter") != SCALE:
        raise ValueError(f"Unsupported units_per_meter: this exporter requires {SCALE}")
    for name, z in [("machine_gun_left", 1), ("machine_gun_right", 1),
                    ("special_launcher", 1), ("turbo_left", -1), ("turbo_right", -1)]:
        if model["attachments"].get(name, {}).get("direction") != [0, 0, z]:
            raise ValueError(f"Unsupported attachment direction for {name}: expected [0, 0, {z}]")


def engine_sample():
    """Synthesize a periodic four-cylinder pulse train as PS1 ADPCM blocks."""
    blocks = 96
    sample_count = blocks * 28
    data = bytearray()
    for block in range(blocks):
        data.extend((5, 6 if block == 0 else 3 if block == blocks - 1 else 2))
        samples = []
        for offset in range(28):
            phase = math.tau * (block * 28 + offset) / sample_count
            rumble = sum(
                strength * math.sin(phase * harmonic + shift)
                for harmonic, strength, shift in [
                    (8, 3.0, 0), (16, 1.4, 0.1), (24, 1.0, 0.2),
                    (32, 0.6, 0.3), (40, 0.4, 0.4), (27, 0.3, 0), (43, 0.2, 0),
                ]
            )
            samples.append(round(rumble) & 15)
        data.extend(samples[i] | samples[i + 1] << 4 for i in range(0, 28, 2))
    return bytes(data)


def export(model):
    validate_authoring_options(model)
    entries = {}
    faces = bytearray()
    vertices = bytearray()
    normals = bytearray()

    def put(p, data, kind=3, count=65535):
        entries[p] = (kind, count, data)

    def number(p, n, kind=4):
        put(p, struct.pack("<i", n), kind)

    def string(p, value):
        data = value.encode("ascii") + b"\0"
        put(p, data + b"\0" * (-len(data) % 4), 2)

    def mount(name):
        a = model["attachments"][name]
        x, y, z = a["direction"]
        return struct.pack("<8h", *game(a["position"]), 0,
                           round(x * 4096), round(-y * 4096), round(z * 4096), 0)

    def crumple(vertex):
        x, y, z = vertex
        front = max(0, (z / SCALE - 1.59) / 0.68) * max(0, min(1, -x / SCALE / 0.58))
        rear = max(0, (-z / SCALE - 1.78) / 0.53) * max(0, (abs(x) / SCALE - 0.59) / 0.21)
        return [round(x + front * 5), round(y - front * 9 - rear * 5),
                round(z - front * 21 + rear * 9)]

    def encode_lod(path, source_groups):
        start_v, start_n = len(vertices) // 8, len(normals) // 8
        groups = []
        # Each local range stays within the renderer's 800-byte scratch allocation.
        for gi, g in enumerate(source_groups):
            gv = []
            gn = []
            gf = []
            for source_face in g["faces"]:
                f = dict(source_face)
                vv = []
                uv = []
                coords = []
                for i, t in zip(f["v"], f["uv"]):
                    p = game(g["vertices"][i])
                    if p not in coords:
                        vv.append(i)
                        uv.append(t)
                        coords.append(p)
                if len(vv) < 3:
                    continue
                if (
                    dot(
                        cross(sub(coords[1], coords[0]), sub(coords[2], coords[0])),
                        cross(sub(coords[1], coords[0]), sub(coords[2], coords[0])),
                    )
                    == 0
                ):
                    continue
                f["v"], f["uv"] = vv, uv
                ids = []
                for i in f["v"]:
                    p = game(g["vertices"][i])
                    if p not in gv:
                        gv.append(p)
                    ids.append(gv.index(p))
                nids = []
                for vertex_id, projected_id in zip(f["v"], ids):
                    n = g["vertex_normals"][vertex_id] if g.get("smooth") else f["normal"]
                    face_direction = unit(
                        cross(
                            sub(coords[3 if len(coords) == 4 else 2], coords[0]),
                            sub(coords[1], coords[0]),
                        )
                    )
                    face_direction = (
                        face_direction[0],
                        -face_direction[1],
                        face_direction[2],
                    )
                    if dot(n, face_direction) < 0.1:
                        n = face_direction
                    normal = [round(-n[0] * 4096), round(n[1] * 4096), round(-n[2] * 4096)]
                    nr = normal + [projected_id]
                    ni = next((j for j, n in enumerate(gn) if n == nr), len(gn))
                    if ni == len(gn):
                        gn.append(nr)
                    nids.append(ni)
                # TM4 accepts positive NCLIP and uses inward-facing lighting normals.
                # Keep the reflected perimeter; only convert quads to GPU strip order.
                order = [0, 1, 2] if len(ids) == 3 else [0, 1, 3, 2]
                iv = [ids[i] for i in order]
                uv = [f["uv"][i] for i in order]
                nids = [nids[i] for i in order]
                if len(iv) == 3:
                    iv.append(iv[-1])
                    uv.append(uv[-1])
                    nids.append(nids[-1])
                code = 0x24 if len(ids) == 3 else 0x2C
                two_sided = int(g["name"] == "wing")
                record = struct.pack(
                    "<4B2BH2BH4B8B",
                    code,
                    two_sided,
                    REFLECTION.get(f["material"], 0),
                    0,
                    *uv[0],
                    44,
                    *uv[1],
                    10,
                    *uv[2],
                    *uv[3],
                    *iv,
                    *nids,
                )
                assert len(record) == 24
                gf.append(record)
            while len(gv) % 3:
                gv.append(gv[-1])
            scratch = len(gv) * 4 + len(gn) * 6
            if scratch > 800 or len(gv) > 255 or len(gn) > 255:
                raise ValueError(
                    f"{g['name']}: scratch={scratch}, vertices={len(gv)}, normals={len(gn)}; split the art group"
                )
            firstf, firstv, firstn = len(faces) // 24, len(vertices) // 8, len(normals) // 8
            frame = struct.pack("<6h", firstf, len(gf), firstv, len(gv), firstn, len(gn))
            if g["wheel"]:
                center = game(g["pivot"])
            else:
                center = [
                    round((min(v[i] for v in gv) + max(v[i] for v in gv)) / 2)
                    for i in range(3)
                ]
            damaged_vertices = gv if g["wheel"] else [crumple(vertex) for vertex in gv]
            damaged = frame
            if damaged_vertices != gv:
                damaged = struct.pack("<6h", firstf, len(gf), firstv + len(gv), len(gv),
                                      firstn, len(gn))
            group = frame + damaged + struct.pack("<3hBb", *center, int(g["wheel"]), gi)
            put(path + "Groups/" + g["name"], group)
            # addPrim prepends packets: overlay faces must be submitted before their backing panels.
            faces.extend(b"".join(reversed(gf)))
            vertices.extend(b"".join(struct.pack("<3hH", *v, 0) for v in gv))
            if damaged_vertices != gv:
                vertices.extend(b"".join(struct.pack("<3hH", *v, 0) for v in damaged_vertices))
            normals.extend(b"".join(struct.pack("<4h", *n) for n in gn))
            groups.append(
                {
                    "name": g["name"],
                    "faces": len(gf),
                    "vertices": len(gv),
                    "normals": len(gn),
                    "scratch_bytes": scratch,
                    "center": center,
                }
            )

        number(path + "NumFaces", sum(group["faces"] for group in groups))
        number(path + "NumVertices", len(vertices) // 8 - start_v)
        number(path + "NumVertexNormals", len(normals) // 8 - start_n)
        number(path + "NumGroups", len(groups))
        # The ordering table prepends packets, so submit near groups first.
        # The recessed floor must draw under the skirts and wheels even at a grazing angle.
        views = bytearray()
        for facing in range(16):
            zc = [0.25, 0.90, -0.25, -0.90][(facing & 6) // 2]
            xc = math.sqrt(1 - zc * zc) * (-1 if facing & 1 else 1)
            yc = 0.7 if facing & 8 else -0.7
            ids = sorted(
                range(len(groups)),
                key=lambda i: (
                    groups[i]["name"] == "underbody",
                    dot(groups[i]["center"], (xc, yc, zc)),
                ),
            )
            views.extend([len(groups), *ids])
        put(path + "viewtable", bytes(views))
        return groups

    groups = encode_lod("display/resolution/r0/", model["groups"])
    distant_groups = encode_lod("display/resolution/r1/", model["distant_groups"])
    number("display/resolution/r0/maxDistanceToDisplay", 1664)
    assert sum(g["faces"] for g in groups) <= model["budget"]["visible_faces"], "Face budget exceeded"
    assert sum(g["vertices"] for g in groups) <= model["budget"]["padded_group_vertices"], (
        "Vertex budget exceeded"
    )
    for name, data in [
        ("FaceList", faces),
        ("VertexList", vertices),
        ("VertexNormalList", normals),
    ]:
        put("display/resolution/" + name, bytes(data))
    for name, value in [
        ("NumFaces", len(faces) // 24),
        ("NumVertices", len(vertices) // 8),
        ("NumVertexNormals", len(normals) // 8),
        ("NumGroups", len(groups) + len(distant_groups)),
    ]:
        number("display/resolution/" + name, value)
    number("display/resolution/scale", SCALE)
    put("display/resolution/translate", struct.pack("<4h", 0, 0, 0, 0), 5)
    # Match original car.bit footprint: one RECT + 192×64 16-bit VRAM words.
    words = [0] * (192 * 64)
    for y in range(64):
        for x in range(64):
            words[y * 192 + x] = sum(
                ATLAS[y * 256 + x * 4 + i] << (i * 4) for i in range(4)
            )
    for i, (r, g, b) in enumerate(PALETTE):
        words[64 + i] = (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10)
    # Original authored shadow in second page, avoiding the CLUT at its top left.
    for y in range(32):
        for x in range(64):
            if ((x - 31.5) / 30) ** 2 + ((y - 15.5) / 14) ** 2 < 1:
                wx = 80 + x // 4
                words[(y + 16) * 192 + wx] |= 1 << ((x % 4) * 4)
    put(
        "display/car.bit",
        struct.pack("<4h", 640, 0, 192, 64) + struct.pack("<%dH" % len(words), *words),
    )
    put("display/shadow", struct.pack("<2BH2BH", 64, 16, 44, 127, 47, 11))
    guns = ("machine_gun_left", "machine_gun_right")
    put("machineGuns", b"".join(mount(name) for name in guns), 26, len(guns))
    put("Laser", mount("special_launcher"), 26, 1)
    put("engineSample", engine_sample())
    put("radarDotColor", bytes([66, 152, 236, 0]), 14)
    number("healthEnergyMax", 9700)

    for name, value in [
        ("massBottom", 218), ("massTop", 111), ("maxAxleTorque", 20_700_000),
        ("engineAxleFric", 31_600), ("frictionAdvantageFront", 1820),
        ("frictionAdvantageBack", 1536), ("turboEngineMultiplier", 8192),
        ("turboEngineAxleFricMultiplier", 6272), ("damageGiveFactor", 3584),
        ("damageReceiveFactor", 3328),
    ]:
        number("physics/" + name, value, 13)
    for name, value in [("physicsBoxHeight", 53), ("physicsBoxWidth", 136),
                        ("physicsBoxLength", 320)]:
        number("physics/" + name, value)
    string("physics/wheelDrive", "four wheel")

    string("special/name", "Laser")
    string("special/hudName", "Ion Lance")
    string("special/launchFunc", "CarLaunchLaser")
    number("special/initial", 3)
    number("special/max", 6)
    number("special/delay", 10240, 13)
    number("special/regen", 62)

    put("display/turbo/emmiter", struct.pack("<4h", *game((0, 0.35, -2.45)), 0), 5)
    for side in ("left", "right"):
        path = "display/turbo/" + side
        put(path + "/pos", mount("turbo_" + side), 15)
        number(path + "/length", 59)
        number(path + "/width", 18)
    put("info.tim", character_info(render(model, None, 32, 19, 210, 137)))
    payload = pack_mr(entries)
    (ROOT / "resources/EVELYN.MR").write_bytes(payload)
    if (ROOT / "resources/raw").exists():
        shutil.rmtree(ROOT / "resources/raw")
    # Raw addressable payloads allow inspection and a later loader handoff without unpack tooling.
    for path, (_, _, data) in entries.items():
        p = ROOT / "resources/raw" / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    return groups


def render(model, path, azimuth=35, elevation=20, w=1200, h=800, gray=False):
    az, el = map(math.radians, (azimuth, elevation))
    eye = (math.sin(az) * math.cos(el), math.sin(el), math.cos(az) * math.cos(el))
    right = unit(cross((0, 1, 0), eye))
    up = cross(eye, right)
    scale = min(w / 5.9, h / 3.9)
    target = (0, 0.65, 0)
    pix = bytearray(w * h * 3)
    depth = [-1e20] * (w * h)
    for y in range(h):
        c = round(24 + 12 * y / h)
        pix[y * w * 3 : (y + 1) * w * 3] = bytes((c, c + 3, c + 5)) * w
    light = unit((-0.5, 1, 0.7))

    def project(p):
        p = sub(p, target)
        depth = dot(p, eye)
        perspective = 8 / (8 - depth) if azimuth % 90 else 1
        return (
            w / 2 + dot(p, right) * scale * perspective,
            h * 0.56 - dot(p, up) * scale * perspective,
            depth,
        )

    # Ground grid and soft contact shadow are rendered in scene space.
    def triangle(
        points, uvs, normal, shadow=False, gray_value=None, corner_normals=None
    ):
        p = [project(v) for v in points]
        den = (p[1][1] - p[2][1]) * (p[0][0] - p[2][0]) + (p[2][0] - p[1][0]) * (
            p[0][1] - p[2][1]
        )
        if abs(den) < 1e-6:
            return
        shade = 1 if shadow else 0.40 + 0.60 * max(0, dot(normal, light))
        shades = (
            [0.40 + 0.60 * max(0, dot(n, light)) for n in corner_normals]
            if corner_normals
            else None
        )
        minx = max(0, math.floor(min(v[0] for v in p)))
        maxx = min(w - 1, math.ceil(max(v[0] for v in p)))
        miny = max(0, math.floor(min(v[1] for v in p)))
        maxy = min(h - 1, math.ceil(max(v[1] for v in p)))
        for y in range(miny, maxy + 1):
            for x in range(minx, maxx + 1):
                a = (
                    (p[1][1] - p[2][1]) * (x + 0.5 - p[2][0])
                    + (p[2][0] - p[1][0]) * (y + 0.5 - p[2][1])
                ) / den
                b = (
                    (p[2][1] - p[0][1]) * (x + 0.5 - p[2][0])
                    + (p[0][0] - p[2][0]) * (y + 0.5 - p[2][1])
                ) / den
                c = 1 - a - b
                if min(a, b, c) < -1e-6:
                    continue
                z = a * p[0][2] + b * p[1][2] + c * p[2][2]
                idx = y * w + x
                if z <= depth[idx]:
                    continue
                depth[idx] = z
                if shades:
                    shade = a * shades[0] + b * shades[1] + c * shades[2]
                if shadow:
                    color = (18, 20, 22)
                elif gray_value is not None:
                    color = (round(gray_value * shade),) * 3
                else:
                    u = round(a * uvs[0][0] + b * uvs[1][0] + c * uvs[2][0])
                    v = round(a * uvs[0][1] + b * uvs[1][1] + c * uvs[2][1])
                    color = tuple(round(t * shade) for t in PALETTE[ATLAS[v * 256 + u]])
                pix[idx * 3 : idx * 3 + 3] = bytes(color)

    for i in range(32):
        a, b = i * math.tau / 32, (i + 1) * math.tau / 32
        triangle(
            [
                (0, 0.003, 0),
                (1.03 * math.cos(a), 0.003, 2.38 * math.sin(a)),
                (1.03 * math.cos(b), 0.003, 2.38 * math.sin(b)),
            ],
            None,
            None,
            True,
        )
    for g in model["groups"]:
        for f in g["faces"]:
            normal = f["normal"]
            if dot(normal, eye) <= 0 and not f.get("double_sided", False):
                continue
            ps = [add(g["vertices"][i], g["pivot"]) for i in f["v"]]
            triangles = [(0, 1, 3), (1, 2, 3)] if len(ps) == 4 else [(0, 1, 2)]
            for tri in triangles:
                gray_value = None
                if gray:
                    material = f.get(
                        "material",
                        TILES[(f["uv"][0][1] // 32) * 8 + f["uv"][0][0] // 32],
                    )
                    gray_value = (
                        55
                        if material in ("glass", "window_edge")
                        else 45
                        if material in ("rubber", "underbody")
                        else 145
                        if material in ("hood", "steel", "grille")
                        else 95
                        if material == "gold"
                        else 210
                    )
                cn = f.get("corner_normals")
                if cn is None and g.get("smooth"):
                    cn = [g["vertex_normals"][i] for i in f["v"]]
                triangle(
                    [ps[i] for i in tri],
                    [f["uv"][i] for i in tri],
                    normal,
                    gray_value=gray_value,
                    corner_normals=[cn[i] for i in tri] if cn else None,
                )
    if path is not None:
        png(path, w, h, pix)
    return pix


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--author",
        action="store_true",
        help="Rebuild editable mesh JSON and atlas from this procedural source",
    )
    parser.add_argument(
        "--render", type=Path, help="Directory for untracked review PNGs"
    )
    args = parser.parse_args()
    src = ROOT / "source/evelyn.mesh.json"
    global ATLAS, PALETTE
    if args.author or not src.exists():
        src.write_text(json.dumps(author(), indent=2) + "\n")
        png(ROOT / "source/atlas.png", 256, 64, [v for i in ATLAS for v in PALETTE[i]])
        (ROOT / "source/atlas.palette.json").write_text(
            json.dumps(
                {"colors": PALETTE, "tiles": {name: uv_tile(name) for name in TILES}},
                indent=2,
            )
            + "\n"
        )
    model = json.loads(src.read_text())
    validate_authoring_options(model)
    PALETTE = json.loads((ROOT / "source/atlas.palette.json").read_text())["colors"]
    assert len(PALETTE) == 16
    ATLAS = [
        min(range(16), key=lambda i: sum((c[j] - PALETTE[i][j]) ** 2 for j in range(3)))
        for c in read_png(ROOT / "source/atlas.png")
    ]
    write_obj(model)
    groups = export(model)
    print(
        f"Exported {len(groups)} groups, {sum(g['faces'] for g in groups)} faces; max scratch {max(g['scratch_bytes'] for g in groups)}/800 bytes"
    )
    if args.render:
        from validate import unpack_model

        model, ATLAS, PALETTE, _ = unpack_model(
            (ROOT / "resources/EVELYN.MR").read_bytes()
        )
        for name, az, el in [
            ("front-three-quarter", 35, 19),
            ("rear-three-quarter", 145, 18),
            ("side", 90, 4),
            ("front", 0, 7),
            ("rear", 180, 7),
        ]:
            path = args.render / (name + ".png")
            render(model, path, az, el)
            print(path)


if __name__ == "__main__":
    main()
