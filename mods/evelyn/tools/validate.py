#!/usr/bin/env python3
"""Evelyn-specific export fidelity, budget and intended placement checks."""

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SLOTS = [
    (640, 0),
    (832, 0),
    (640, 64),
    (832, 64),
    (640, 128),
    (832, 128),
    (640, 192),
    (832, 192),
]


def need(condition, message):
    if not condition:
        raise ValueError(message)


def read_mr(data):
    need(data[:4] in (b"\x67\0\0\0", b"\x67\0\xcc\xcc"), "MR magic")
    entries = {}
    locations = {}
    dirs = []

    def get(pos, n):
        need(0 <= pos <= len(data) - n, "MR extent out of bounds")
        return data[pos : pos + n]

    def name(pos, header):
        length = get(pos, 1)[0]
        need(length > 0 and length % 4 == 0, "MR name padding")
        raw = get(pos + header, length)
        need(b"\0" in raw, "MR terminated name")
        text = raw.split(b"\0")[0].decode("ascii")
        need(text and "/" not in text, "MR name")
        return text, length

    def folder(pos, parent, depth=0):
        need(depth < 32, "MR directory cycle/depth")
        nm, n = name(pos, 4)
        nd, nf = struct.unpack_from("<BH", get(pos + 1, 3))
        path = parent + [nm]
        dirs.append("/".join(path))
        pos += 4 + n
        for _ in range(nf):
            key, n = name(pos, 12)
            kind, count, size, expanded = struct.unpack("<BHII", get(pos + 1, 11))
            start = pos + 12 + n
            need(expanded == 0, "Prototype must use inspectable uncompressed payloads")
            full = "/".join(path + [key])
            need(full not in entries, "Duplicate registry file")
            entries[full] = (kind, count, get(start, size))
            locations[full] = start
            pos = start + size
        for _ in range(nd):
            pos = folder(pos, path, depth + 1)
        return pos

    end = folder(4, [])
    need(end == len(data), "MR trailing data")
    return entries, locations, dirs


def unpack_model(blob):
    entries, locations, dirs = read_mr(blob)
    source = json.loads((ROOT / "source/evelyn.mesh.json").read_text())
    source_groups = {g["name"]: g for g in source["groups"]}

    def entry(p):
        return entries["Root/" + p][2]

    base = "display/resolution/"

    def count(n):
        kind, a, data = entries["Root/" + base + n]
        need(kind == 4 and len(data) == 4, "Long metadata " + n)
        return struct.unpack("<i", data)[0]

    face_blob = entry(base + "FaceList")
    vertex_blob = entry(base + "VertexList")
    normal_blob = entry(base + "VertexNormalList")
    nf, nv, nn, ng = [
        count(n) for n in ("NumFaces", "NumVertices", "NumVertexNormals", "NumGroups")
    ]
    need(len(face_blob) == 24 * nf, "FaceList extent")
    need(len(vertex_blob) == 8 * nv, "VertexList extent")
    need(len(normal_blob) == 8 * nn, "VertexNormalList extent")
    vertices = list(struct.iter_unpack("<4h", vertex_blob))
    normals = list(struct.iter_unpack("<4h", normal_blob))
    model = {"groups": []}
    stats = []
    covered_faces = set()
    covered_vertices = set()
    covered_normals = set()
    used_sorts = set()
    for path, (kind, count_, data) in entries.items():
        if not path.startswith("Root/" + base + "r0/Groups/"):
            continue
        name = path.split("/")[-1]
        need(kind == 3 and len(data) == 32, "Group payload " + name)
        frames = [struct.unpack_from("<6h", data, i * 12) for i in range(2)]
        center = struct.unpack_from("<3hBb", data, 24)
        need(
            frames[0] == frames[1],
            "Initial prototype frames must alias intact geometry",
        )
        ff, fc, fv, vc, fn, nc = frames[0]
        need(
            min(ff, fc, fv, vc, fn, nc) >= 0 and fc and vc and nc,
            "Empty/negative group " + name,
        )
        need(ff + fc <= nf and fv + vc <= nv and fn + nc <= nn, "Group range " + name)
        need(vc % 3 == 0, "RTPT reads a complete triple " + name)
        need(vc <= 255 and nc <= 255, "Byte index capacity " + name)
        scratch = 4 * vc + 6 * nc
        need(scratch <= 1024 - 0xE0, "Scratchpad overflow " + name)
        need(center[4] not in used_sorts and center[4] >= 0, "Unique sort key " + name)
        used_sorts.add(center[4])
        wheel = name in ("fl_wheel", "fr_wheel", "rr_wheel", "rl_wheel")
        need(center[3] == int(wheel), "Pivot validity " + name)
        gv = [(v[0] / 50, -v[1] / 50, v[2] / 50) for v in vertices[fv : fv + vc]]
        pivot = (
            (center[0] / 50, -center[1] / 50, center[2] / 50) if wheel else (0, 0, 0)
        )
        group = {
            "name": name,
            "vertices": gv,
            "pivot": pivot,
            "wheel": wheel,
            "faces": [],
            "sort": center[4],
        }
        for n in normals[fn : fn + nc]:
            need(0 <= n[3] < vc, "Normal projected vertex " + name)
            need(
                abs(math.sqrt(sum(c * c for c in n[:3])) - 4096) < 2,
                "Q12 normal length " + name,
            )
        for i in range(ff, ff + fc):
            need(i not in covered_faces, "Overlapping groups")
            covered_faces.add(i)
            f = face_blob[i * 24 : (i + 1) * 24]
            need(
                f[0] in (0x24, 0x2C)
                and f[1] == int(name == "wing")
                and f[2:4] == b"\0\0",
                "Face opcode/flags",
            )
            degree = 3 if f[0] == 0x24 else 4
            iv = list(f[16:20])
            ni = list(f[20:24])
            need(all(v < vc for v in iv), "Face vertex index " + name)
            need(all(n < nc for n in ni), "Face normal index " + name)
            need(
                all(normals[fn + n][3] == v for v, n in zip(iv, ni)),
                "Authored corner association mismatch " + name,
            )
            need(len(set(iv[:3])) == 3, "Degenerate triangle " + name)
            points = [vertices[fv + v][:3] for v in iv[:3]]
            a = [points[1][j] - points[0][j] for j in range(3)]
            b = [points[2][j] - points[0][j] for j in range(3)]
            normal = (
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            )
            need(any(normal), "Zero area face " + name)
            need(
                sum(normal[j] * normals[fn + ni[0]][j] for j in range(3)) > 0,
                "Face winding disagrees with normal " + name,
            )
            if degree == 4:
                p1, p2, p3 = [vertices[fv + iv[k]][:3] for k in (1, 2, 3)]
                a = [p3[j] - p1[j] for j in range(3)]
                b = [p2[j] - p1[j] for j in range(3)]
                second = (
                    a[1] * b[2] - a[2] * b[1],
                    a[2] * b[0] - a[0] * b[2],
                    a[0] * b[1] - a[1] * b[0],
                )
                need(any(second), "Zero area second quad triangle " + name)
            uv = [list(f[4:6]), list(f[8:10]), list(f[12:14]), list(f[14:16])]
            clut, page = (
                struct.unpack_from("<H", f, 6)[0],
                struct.unpack_from("<H", f, 10)[0],
            )
            need(clut == 44 and page == 10, "Texture binding")
            need(all(1 <= u <= 254 and 1 <= v <= 62 for u, v in uv), "UV bounds")
            order = [0, 1, 2] if degree == 3 else [0, 1, 3, 2]
            length = math.sqrt(sum(c * c for c in normal))
            n = [c * 4096 / length for c in normal]
            cn = [normals[fn + ni[k]] for k in order]
            group["faces"].append(
                {
                    "corner_normals": [
                        (-c[0] / 4096, c[1] / 4096, -c[2] / 4096) for c in cn
                    ],
                    "double_sided": bool(f[1]),
                    "v": [iv[k] for k in order],
                    "uv": [uv[k] for k in order],
                    "normal": (-n[0] / 4096, n[1] / 4096, -n[2] / 4096),
                }
            )
        covered_vertices.update(range(fv, fv + vc))
        covered_normals.update(range(fn, fn + nc))
        if wheel:
            src = source_groups[name]
            expected_pivot = tuple(round(v * 50) / 50 for v in src["pivot"])
            need(pivot == expected_pivot, "Wheel pivot placement " + name)
            radius_y = (max(v[1] for v in gv) - min(v[1] for v in gv)) / 2
            radius_z = (max(v[2] for v in gv) - min(v[2] for v in gv)) / 2
            need(
                radius_y == radius_z and 0.25 <= radius_y <= 0.40,
                "Wheel radius / rolling axis X " + name,
            )
        stats.append((name, fc, vc, nc, scratch))
        model["groups"].append(group)
    need(len(stats) == ng, "Group count")
    need(
        covered_faces == set(range(nf))
        and covered_vertices == set(range(nv))
        and covered_normals == set(range(nn)),
        "Unreferenced geometry",
    )
    need(
        used_sorts == set(range(ng)), "Group sort keys must be contiguous for viewtable"
    )
    for n, v in [
        ("NumFaces", nf),
        ("NumVertices", nv),
        ("NumVertexNormals", nn),
        ("NumGroups", ng),
    ]:
        need(count("r0/" + n) == v, "r0 metadata " + n)
    need("Root/display/resolution/r1" not in dirs, "Prototype unexpectedly has LOD")
    view = entry(base + "r0/viewtable")
    need(len(view) == 16 * (ng + 1), "Viewtable stride/count")
    for i in range(16):
        row = view[i * (ng + 1) : (i + 1) * (ng + 1)]
        need(
            row[0] == ng and sorted(row[1:]) == list(range(ng)),
            "Viewtable group indices",
        )
    model["groups"].sort(key=lambda g: g["sort"])
    wheels = {g["name"] for g in model["groups"] if g["wheel"]}
    need(len(wheels) == 4, "Four independent wheels")
    mounts = entries["Root/machineGuns"]
    need(mounts[:2] == (26, 2) and len(mounts[2]) == 32, "machineGuns array contract")
    for i in range(2):
        mount = struct.unpack_from("<8h", mounts[2], i * 16)
        anchor = source["attachments"][
            "machine_gun_left" if i == 0 else "machine_gun_right"
        ]["position"]
        expected = (
            round(anchor[0] * 50),
            round(-anchor[1] * 50),
            round(anchor[2] * 50),
            0,
        )
        need(mount[:4] == expected and mount[4:] == (0, 0, 4096, 0), "Muzzle transform")
    bit = entry("display/car.bit")
    need(
        struct.unpack_from("<4h", bit) == (640, 0, 192, 64) and len(bit) == 24584,
        "car.bit rectangle/extent",
    )
    words = struct.unpack_from("<12288H", bit, 8)
    palette = [
        (
            (v & 31) * 255 // 31,
            ((v >> 5) & 31) * 255 // 31,
            ((v >> 10) & 31) * 255 // 31,
        )
        for v in words[64:80]
    ]
    need(
        words[64] == 0 and all(v != 0 for v in words[65:80]),
        "Transparent index zero only",
    )
    atlas = [
        (words[y * 192 + x // 4] >> ((x % 4) * 4)) & 15
        for y in range(64)
        for x in range(256)
    ]
    # Simulate actual car relocation into each loader slot and read back every atlas texel.
    for sx, sy in SLOTS:
        dx, dy = sx - 640, sy
        new_page = (10 & 0x180) | 0x20 | (((640 + dx) >> 6) & 15) | ((dy & 0x100) >> 4)
        px = (new_page & 15) * 64
        py = (new_page & 16) * 16
        clut_x, clut_y = 704 + dx, dy
        need(
            sx <= clut_x and clut_x + 16 <= sx + 192 and sy <= clut_y < sy + 64,
            "Relocated CLUT bounds",
        )
        for y in range(64):
            for x in range(256):
                u = x + 640 + dx - px
                v = y + dy - py
                need(0 <= u <= 255 and 0 <= v <= 255, "Relocated UV byte range")
                wx = px + u // 4 - sx
                wy = py + v - sy
                need(0 <= wx < 192 and 0 <= wy < 64, "Relocated texture address")
                need(
                    ((words[wy * 192 + wx] >> ((u % 4) * 4)) & 15)
                    == atlas[y * 256 + x],
                    "Relocated texture content",
                )
    shadow = entry("display/shadow")
    need(
        shadow == struct.pack("<2BH2BH", 64, 16, 44, 127, 47, 11),
        "Shadow texture rectangle",
    )
    pts = [
        tuple(v[j] + g["pivot"][j] for j in range(3))
        for g in model["groups"]
        for v in g["vertices"]
    ]
    bounds = [(min(p[j] for p in pts), max(p[j] for p in pts)) for j in range(3)]
    need(bounds[1][0] == 0 and 1.35 <= bounds[1][1] <= 1.55, "Ground/roof bounds")
    budget = json.loads((ROOT / "source/evelyn.mesh.json").read_text())["budget"]
    need(
        nf <= budget["visible_faces"] and nv <= budget["padded_group_vertices"],
        "Reference-based art budget",
    )
    report = [
        f"MR SHA-256: {hashlib.sha256(blob).hexdigest()}",
        f"{len(entries)} registry payloads; {ng} independently addressable groups",
        f"{nf} faces; {nv} padded vertices; {nn} normals; two aliased frame slots",
        f"Author-space bounds (m): {bounds}",
        f"Maximum renderer scratch usage: {max(r[4] for r in stats)}/800 bytes",
        "PASS: MR ranges, types, counts, group/frame extents, indices, winding, normal lengths, UV bindings",
        "PASS: all 16 view rows, four local wheel pivots, X rolling axes, two muzzle mounts",
        "PASS: packed bitmap/palette and texel-preserving relocation into all eight original car slots",
        "UNTESTED: runtime registration, engine rendering/order/clipping, collision/physics, VRAM/packet competition",
        "",
        "group                         faces vertices normals scratch",
    ]
    report.extend(f"{n:29s} {f:5d} {v:8d} {q:7d} {s:7d}" for n, f, v, q, s in stats)
    return model, atlas, palette, "\n".join(report) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", type=Path)
    ap.add_argument("--reference-root", type=Path)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    blob = (ROOT / "resources/EVELYN.MR").read_bytes()
    model, atlas, palette, report = unpack_model(blob)
    if args.reference_root:
        sys.path.insert(0, str(args.reference_root / "tools"))
        from overlay_resources import MR

        parsed = MR(blob)
        entries, _, _ = read_mr(blob)
        need(
            len(parsed.entries) == len(entries), "Independent upstream MR reader count"
        )
        for e in parsed.entries:
            need(
                e["_payload"] == entries["/".join(e["parts"])][2],
                "Independent upstream payload comparison",
            )
        report += "PASS: independent upstream MR parser agrees byte-for-byte on every payload\n"
    if args.self_test:
        _, loc, _ = read_mr(blob)
        normal_location = loc["Root/display/resolution/VertexNormalList"]
        current = struct.unpack_from("<h", blob, normal_location + 6)[0]
        mutations = [
            (
                "in-range normal association",
                normal_location + 6,
                struct.pack("<h", 1 if current == 0 else 0),
            ),
            ("face index", loc["Root/display/resolution/FaceList"] + 16, b"\xff"),
            (
                "group extent",
                loc["Root/display/resolution/r0/Groups/fl_wheel"] + 2,
                b"\xff\x7f",
            ),
            ("view row", loc["Root/display/resolution/r0/viewtable"] + 1, b"\xff"),
            ("bitmap size", loc["Root/display/car.bit"] + 4, b"\x01\0"),
            (
                "normal vertex",
                loc["Root/display/resolution/VertexNormalList"] + 6,
                b"\xff\x7f",
            ),
        ]
        for label, pos, value in mutations:
            bad = bytearray(blob)
            bad[pos : pos + len(value)] = value
            try:
                unpack_model(bytes(bad))
            except ValueError:
                continue
            raise ValueError("Validator did not reject mutated " + label)
        report += "PASS: six corruption probes rejected, including an in-range wrong normal association\n"
    print(report, end="")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report)


if __name__ == "__main__":
    main()
