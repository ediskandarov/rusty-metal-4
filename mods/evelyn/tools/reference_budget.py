#!/usr/bin/env python3
"""Read original car budgets from the original disc; never extract/copy art."""

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

# Semantic grouping is inferred from original group names, not claimed as source ownership.
ACCESSORIES = {
    "MEDA.MR": {"r0": {"gL", "gR"}, "r1": set(), "r2": set()},
    "CADA.MR": {"r0": set(), "r1": set(), "r2": set()},
    "THUMP.MR": {
        "r0": {
            "ant",
            "covee",
            "cover",
            "covet",
            "gunee",
            "gunf",
            "gunt",
            "gunv",
            "pipef",
            "pipet",
        },
        "r1": {"ant", "gone", "gtwo", "gunee", "gunf", "gunt", "gunv", "t"},
        "r2": set(),
    },
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--disc", type=Path, required=True)
    ap.add_argument("--recovery-root", type=Path, required=True)
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()
    repo = Path(__file__).resolve().parents[3]
    expected = json.loads((repo / "config/disc.json").read_text())["files"][0]["sha256"]
    actual = hashlib.file_digest(args.disc.open("rb"), "sha256").hexdigest()
    if actual != expected:
        raise ValueError("Disc does not match pinned original Track 01")
    sys.path.insert(0, str(args.recovery_root / "tools"))
    from overlay_resources import Disc, MR

    disc = Disc(args.disc)
    out = [
        "Original-disc car geometry budgets",
        "Counts are frame 0 group-local ranges: faces / vertices; r2 is the combined impostor.",
        "Body = non-wheel groups except explicit attachment sets below. Group semantics are inferred.",
        "Stored rN NumFaces can also contain damaged-frame ranges and is NOT the visible-face budget.",
        "",
        "car        LOD body F/V  wheels F/V attachments F/V total F/V stored faces",
    ]
    for row in disc.entries():
        name = row["original_path"].split("/")[-1].split(";")[0]
        if name not in ACCESSORIES or row["original_path"].count("/") != 2:
            continue
        blob = disc.read(row["lba"], row["size"])[0]
        mr = MR(blob)
        for lod in ("r0", "r1", "r2"):
            categories = [[0, 0], [0, 0], [0, 0]]
            for e in mr.entries:
                if "/display/resolution/" + lod + "/Groups/" not in "/".join(
                    e["parts"]
                ):
                    continue
                n = e["parts"][-1]
                a = struct.unpack_from("<6h", e["_payload"])
                category = (
                    1
                    if "wheel" in n.lower()
                    else 2
                    if n in ACCESSORIES[name][lod]
                    else 0
                )
                categories[category][0] += a[1]
                categories[category][1] += a[3]
            total = [sum(c[i] for c in categories) for i in range(2)]
            stored = struct.unpack(
                "<i", mr.lookup(["Root", "display", "resolution", lod, "NumFaces"])
            )[0]
            show = lambda n: f"{n[0]}/{n[1]}"
            out.append(
                f"{name:10s} {lod:3s} {show(categories[0]):9s} {show(categories[1]):10s} {show(categories[2]):15s} {show(total):9s} {stored}"
            )
        out.append(f"  Source MR SHA-256: {hashlib.sha256(blob).hexdigest()}")
    out += ["", "Explicit inferred attachment groups:"]
    for name, lods in ACCESSORIES.items():
        for lod, groups in lods.items():
            if groups:
                out.append(f"{name} {lod}: " + ", ".join(sorted(groups)))
    out += [
        "",
        "Evelyn selected cap: 360 visible faces / 960 padded group-local vertices, one LOD.",
        "Thumper is the armed road-car comparison. The allowance prioritizes curved body/roof surfaces",
        "and recognizable glazing/arches; four twelve-sided wheels use coherent original rim textures.",
        "The same original 192x64-word bitmap slot is used; new art occupies one 256x64 4-bit page + palette/shadow.",
    ]
    text = "\n".join(out) + "\n"
    print(text, end="")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text)


if __name__ == "__main__":
    main()
