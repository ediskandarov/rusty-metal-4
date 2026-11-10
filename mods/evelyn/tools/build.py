#!/usr/bin/env python3
"""Author, export and render the standalone Evelyn prototype; Python stdlib only."""

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

ROOT = Path(__file__).resolve().parents[1]
SCALE = 50  # authoring choice, matching the scale field found in original car resources
PALETTE = [
    (0, 0, 0),
    (24, 26, 28),
    (48, 48, 45),
    (77, 71, 59),
    (112, 70, 40),
    (166, 80, 34),
    (212, 103, 35),
    (232, 129, 53),
    (241, 190, 105),
    (135, 108, 53),
    (189, 151, 70),
    (231, 196, 111),
    (41, 62, 67),
    (75, 100, 104),
    (201, 211, 190),
    (151, 39, 30),
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
                    c = 8 if y < 7 else 15
                    if y % 5 == 0:
                        c = 4
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

    def cylinder(
        self, center, radius, length, axis="z", material="steel", segments=8, caps=True
    ):
        def p(a, t):
            v = (radius * math.cos(a), radius * math.sin(a), t)
            if axis == "x":
                v = (t, v[0], v[1])
            return add(center, v)

        for i in range(segments):
            a, b = i * math.tau / segments, (i + 1) * math.tau / segments
            self.face(
                [
                    p(a, -length / 2),
                    p(b, -length / 2),
                    p(b, length / 2),
                    p(a, length / 2),
                ],
                material,
                sub(p((a + b) / 2, 0), center),
            )
        if caps:
            for side in (-1, 1):
                c = list(center)
                c[0 if axis == "x" else 2] += side * length / 2
                n = (side, 0, 0) if axis == "x" else (0, 0, side)
                for i in range(segments):
                    self.face(
                        [
                            c,
                            p(i * math.tau / segments, side * length / 2),
                            p((i + 1) * math.tau / segments, side * length / 2),
                        ],
                        material,
                        n,
                    )

    def data(self):
        smooth = self.name.startswith("body_") or self.name in (
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


def author():
    groups = []

    def group(n, p=(0, 0, 0), wheel=False):
        m = Mesh(n, p, wheel)
        groups.append(m)
        return m

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

    zs = [
        -2.02,
        -1.92,
        -1.65,
        -1.54,
        -1.28,
        -1.02,
        -0.91,
        -0.65,
        0.12,
        0.64,
        0.89,
        1.0,
        1.26,
        1.52,
        1.63,
        1.92,
        2.02,
    ]
    for side, label in [(-1, "left"), (1, "right")]:
        m = group("body_" + label)

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

        for a, b in zip(zs, zs[1:]):
            for j in range(3):
                if j == 0 and min(arch(a), arch(b)) >= 0.57:
                    continue
                ps = [row(a, j), row(b, j), row(b, j + 1), row(a, j + 1)]
                if max(p[1] for p in ps) - min(p[1] for p in ps) < 0.015:
                    continue
                m.face(ps, "paint" if j else "paint_dark", (side, 0, 0))
        m = group("wheel_arch_" + label)
        for center in (-1.28, 1.26):
            for i in range(6):
                a, b = i * math.pi / 6, (i + 1) * math.pi / 6
                m.face(
                    [
                        (
                            side * (breadth(center) + 0.018),
                            0.32 + 0.37 * math.sin(a),
                            center + 0.37 * math.cos(a),
                        ),
                        (
                            side * (breadth(center) + 0.018),
                            0.32 + 0.37 * math.sin(b),
                            center + 0.37 * math.cos(b),
                        ),
                        (
                            side * (breadth(center) + 0.04),
                            0.32 + 0.405 * math.sin(b),
                            center + 0.405 * math.cos(b),
                        ),
                        (
                            side * (breadth(center) + 0.04),
                            0.32 + 0.405 * math.sin(a),
                            center + 0.405 * math.cos(a),
                        ),
                    ],
                    "hood",
                    (side, 1, 0),
                )
        # Arched four-door greenhouse. B pillar sits just behind the driver's seat.
        m = group("cabin_" + label)
        outline = [
            (0.73, 0.98),
            (0.44, 1.22),
            (0.15, 1.40),
            (-0.12, 1.46),
            (-0.70, 1.44),
            (-0.94, 1.33),
            (-1.46, 0.98),
        ]

        # Coordinates above are Z,Y; tuck roof shoulders inward, instead of flat slab sides.
        def cab(z, y):
            return (side * (0.77 - (y - 0.98) * 0.31), y, z)

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
            for i in range(1, len(ps) - 1):
                m.face([ps[0], ps[i], ps[i + 1]], "glass", (side, 0, 0))
        # Door outlines and handles make the two doors legible without texture noise.
        m = group("door_details_" + label)
        for z in (0.70, -0.24, -1.28):
            lo = max(arch(z), 0.26)
            mid = max(lo, 0.57)
            w = breadth(z)
            rows = [(lo, w - 0.06), (mid, w + 0.04), (shoulder(z), w - 0.005)]
            for (ya, xa), (yb, xb) in zip(rows, rows[1:]):
                if yb - ya > 0.01:
                    m.face(
                        [
                            (side * xa, ya, z),
                            (side * xa, ya, z + 0.018),
                            (side * xb, yb, z + 0.018),
                            (side * xb, yb, z),
                        ],
                        "window_edge",
                        (side, 0, 0),
                    )
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
    m = group("hood")
    hr = [
        (2.15, 0.865, 0.695),
        (1.75, 0.91, 0.735),
        (1.12, 0.96, 0.77),
        (0.73, 0.98, 0.755),
    ]
    for (za, ya, wa), (zb, yb, wb) in zip(hr, hr[1:]):
        columns = (
            [(-1, -0.6), (-0.6, 0), (0, 0.6), (0.6, 1)]
            if za == 2.15
            else [(-1, 0), (0, 1)]
        )
        for a, b in columns:
            m.face(
                [
                    (
                        wa * a,
                        ya + (0.035 if a == 0 and za != 2.15 else 0),
                        za - (0.13 if za == 2.15 and abs(a) == 1 else 0),
                    ),
                    (
                        wa * b,
                        ya + (0.035 if b == 0 and za != 2.15 else 0),
                        za - (0.13 if za == 2.15 and abs(b) == 1 else 0),
                    ),
                    (wb * b, yb + (0.035 if b == 0 else 0), zb),
                    (wb * a, yb + (0.035 if a == 0 else 0), zb),
                ],
                "hood",
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
        columns = (
            [(-1, -0.6), (-0.6, 0), (0, 0.6), (0.6, 1)]
            if zb == -2.15
            else [(-1, 0), (0, 1)]
        )
        for a, b in columns:
            m.face(
                [
                    (wa * a, ya + (0.025 if a == 0 else 0), za),
                    (wa * b, ya + (0.025 if b == 0 else 0), za),
                    (
                        wb * b,
                        yb + (0.025 if b == 0 and zb != -2.15 else 0),
                        zb + (0.13 if zb == -2.15 and abs(b) == 1 else 0),
                    ),
                    (
                        wb * a,
                        yb + (0.025 if a == 0 and zb != -2.15 else 0),
                        zb + (0.13 if zb == -2.15 and abs(a) == 1 else 0),
                    ),
                ],
                "paint",
                (0, 1, 0),
            )
    # Chamfered nose and tail: changing widths/depths replace the old vertical boxes.
    for label, sign in [("front", 1), ("rear", -1)]:
        m = group(label + "_bumper")
        rows = [
            (0.23, 0.70, 2.12),
            (0.42, 0.795, 2.24),
            (0.57, 0.795, 2.24),
            (0.80, 0.745, 2.20),
            (0.865, 0.695, 2.15),
        ]
        for (ya, wa, za), (yb, wb, zb) in zip(rows, rows[1:]):
            for a, b in [(-1, -0.6), (-0.6, 0.6), (0.6, 1)]:
                depth = lambda t, z: 2.02 if abs(t) == 1 else z
                m.face(
                    [
                        (wa * a, ya, sign * depth(a, za)),
                        (wa * b, ya, sign * depth(b, za)),
                        (wb * b, yb, sign * depth(b, zb)),
                        (wb * a, yb, sign * depth(a, zb)),
                    ],
                    "paint_dark" if ya < 0.3 else "paint",
                    (0, 0, sign),
                )
    m = group("lamps_grilles")
    m.face(
        [
            (-0.42, 0.35, 2.26),
            (0.42, 0.35, 2.26),
            (0.42, 0.51, 2.26),
            (-0.42, 0.51, 2.26),
        ],
        "grille",
        (0, 0, 1),
    )
    m.face(
        [
            (-0.30, 0.62, 2.23),
            (0.30, 0.62, 2.23),
            (0.26, 0.77, 2.20),
            (-0.26, 0.77, 2.20),
        ],
        "grille",
        (0, 0, 1),
    )
    for side in (-1, 1):
        cx = side * 0.53
        ps = [
            (
                cx + 0.17 * math.cos(i * math.tau / 8),
                0.735 + 0.145 * math.sin(i * math.tau / 8),
                2.26 - max(0, abs(cx + 0.17 * math.cos(i * math.tau / 8)) - 0.45) * 0.6,
            )
            for i in range(8)
        ]
        for ids in ((0, 1, 2, 3), (0, 3, 4, 5), (0, 5, 6, 7)):
            points = [ps[i] for i in ids]
            uv = [
                [
                    143 + round((p[0] - cx) / 0.17 * 14),
                    47 - round((p[1] - 0.735) / 0.145 * 14),
                ]
                for p in points
            ]
            m.face(points, "light", (0, 0, 1), uv=uv)
        a, b = sorted((side * 0.45, side * 0.73))
        m.face(
            [
                (a, 0.60, -2.28 + max(0, abs(a) - 0.45) * 0.70),
                (b, 0.60, -2.28 + max(0, abs(b) - 0.45) * 0.70),
                (b, 0.80, -2.245 + max(0, abs(b) - 0.45) * 0.65),
                (a, 0.80, -2.245 + max(0, abs(a) - 0.45) * 0.65),
            ],
            "tail",
            (0, 0, -1),
        )
    m.face(
        [
            (-0.22, 0.44, -2.26),
            (0.22, 0.44, -2.26),
            (0.22, 0.61, -2.26),
            (-0.22, 0.61, -2.26),
        ],
        "plate",
        (0, 0, -1),
        uv=[[94, 33], [65, 33], [65, 62], [94, 62]],
    )
    m = group("underbody")
    m.face(
        [(-0.7, 0.22, -1.8), (0.7, 0.22, -1.8), (0.7, 0.22, 1.8), (-0.7, 0.22, 1.8)],
        "underbody",
        (0, -1, 0),
    )
    # Twelve-sided round tires; rim/spoke art uses a single coherent mapped disc.
    for name, x, z in [
        ("fl_wheel", -0.76, 1.26),
        ("fr_wheel", 0.76, 1.26),
        ("rr_wheel", 0.76, -1.28),
        ("rl_wheel", -0.76, -1.28),
    ]:
        m = group(name, (x, 0.32, z), True)
        side = 1 if x > 0 else -1
        for i in range(12):
            a, b = i * math.tau / 12, (i + 1) * math.tau / 12
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
                    0.32 * math.sin(i * math.tau / 12),
                    0.32 * math.cos(i * math.tau / 12),
                )
                for i in range(12)
            ]
            for ids in (
                (0, 1, 2, 3),
                (0, 3, 4, 5),
                (0, 5, 6, 7),
                (0, 7, 8, 9),
                (0, 9, 10, 11),
            ):
                ps = [ring[i] for i in ids]
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
        m.box((x - 0.035, 0.92, -2.00), (x + 0.035, 1.17, -1.78), "paint")
    m.box((-0.80, 1.15, -2.01), (0.80, 1.20, -1.77), "paint")
    for side, label in [(-1, "left"), (1, "right")]:
        m = group("fender_gun_" + label)
        x = side * 0.89
        lo, hi = sorted((side * 0.85, side * 0.93))
        m.box((lo, 0.88, 0.76), (hi, 1.00, 1.10), "steel")
        m.cylinder((x, 0.94, 1.40), 0.03, 0.60, "z", "steel", 4, False)
        m.face(
            [
                (x - 0.03, 0.91, 1.72),
                (x + 0.03, 0.91, 1.72),
                (x + 0.03, 0.97, 1.72),
                (x - 0.03, 0.97, 1.72),
            ],
            "underbody",
            (0, 0, 1),
        )
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
    m = group("hood_vents")
    for side in (-1, 1):
        a, b = sorted((side * 0.20, side * 0.49))
        m.face(
            [(a, 0.982, 1.20), (b, 0.982, 1.20), (b, 0.95, 1.61), (a, 0.95, 1.61)],
            "vent",
            (0, 1, 0),
        )
    return {
        "name": "Evelyn resource prototype",
        "units": "meters",
        "axes": "X right, Y up, Z forward; export X right, Y down, Z forward",
        "units_per_meter": SCALE,
        "budget": {"visible_faces": 360, "padded_group_vertices": 960},
        "groups": [g.data() for g in groups],
        "attachments": {
            "machine_gun_left": {
                "position": [-0.89, 0.94, 1.72],
                "direction": [0, 0, 1],
            },
            "machine_gun_right": {
                "position": [0.89, 0.94, 1.72],
                "direction": [0, 0, 1],
            },
            "future_special_rail": {
                "position": [0, 0.97, -1.48],
                "direction": [0, 0, 1],
            },
        },
    }


def game(v):
    return [round(v[0] * SCALE), round(-v[1] * SCALE), round(v[2] * SCALE)]


def write_obj(model):
    lines = [
        "# Original Evelyn prototype; meters, Y up, Z forward",
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
    for name in ("machine_gun_left", "machine_gun_right"):
        if model["attachments"][name].get("direction") != [0, 0, 1]:
            raise ValueError(
                f"Unsupported attachment direction for {name}: expected [0, 0, 1]"
            )


def export(model):
    validate_authoring_options(model)
    entries = {}
    faces = bytearray()
    vertices = bytearray()
    normals = bytearray()
    groups = []

    def put(p, data, kind=3, count=65535):
        entries[p] = (kind, count, data)

    def number(p, n):
        put(p, struct.pack("<i", n), 4)

    # Groups are split for PS1's 800-byte remaining scratchpad, without changing wheel identity.
    # Wheels need one group each, so deduplicate normals and vertices after quantization.
    for gi, g in enumerate(model["groups"]):
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
                0,
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
        group = frame * 2 + struct.pack("<3hBb", *center, int(g["wheel"]), gi)
        put("display/resolution/r0/Groups/" + g["name"], group)
        # addPrim prepends packets: overlay faces must be submitted before their backing panels.
        faces.extend(b"".join(reversed(gf)))
        vertices.extend(b"".join(struct.pack("<3hH", *v, 0) for v in gv))
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
    assert len(faces) // 24 <= model["budget"]["visible_faces"], "Face budget exceeded"
    assert len(vertices) // 8 <= model["budget"]["padded_group_vertices"], (
        "Vertex budget exceeded"
    )
    for name, data in [
        ("FaceList", faces),
        ("VertexList", vertices),
        ("VertexNormalList", normals),
    ]:
        put("display/resolution/" + name, bytes(data))
    for base in ("display/resolution/", "display/resolution/r0/"):
        for n, v in [
            ("NumFaces", len(faces) // 24),
            ("NumVertices", len(vertices) // 8),
            ("NumVertexNormals", len(normals) // 8),
            ("NumGroups", len(groups)),
        ]:
            number(base + n, v)
    # All groups visible from each direction; sort their bounds far-to-near for painter rendering.
    views = bytearray()
    for facing in range(16):
        zc = [0.25, 0.90, -0.25, -0.90][(facing & 6) // 2]
        xc = math.sqrt(1 - zc * zc) * (-1 if facing & 1 else 1)
        yc = 0.7 if facing & 8 else -0.7
        ids = sorted(
            range(len(groups)), key=lambda i: dot(groups[i]["center"], (xc, yc, zc))
        )
        views.extend([len(groups), *ids])
    put("display/resolution/r0/viewtable", bytes(views))
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
    anchors = []
    for name in ("machine_gun_left", "machine_gun_right"):
        a = model["attachments"][name]
        anchors.append(struct.pack("<8h", *game(a["position"]), 0, 0, 0, 4096, 0))
    put("machineGuns", b"".join(anchors), 26, 2)
    # Custom authoring metadata is kept separate, not injected as an invented runtime contract.
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
    png(path, w, h, pix)


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
