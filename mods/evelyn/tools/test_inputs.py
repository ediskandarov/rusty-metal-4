#!/usr/bin/env python3
"""Focused regressions for supported editable atlas and metadata inputs."""

import binascii
import struct
import tempfile
import unittest
import zlib
from pathlib import Path

from build import read_png, validate_authoring_options


def png(mode, pixel, transparency=None):
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", binascii.crc32(tag + data))
        )

    result = b"\x89PNG\r\n\x1a\n"
    result += chunk(b"IHDR", struct.pack(">2I5B", 256, 64, 8, mode, 0, 0, 0))
    if mode == 3:
        result += chunk(b"PLTE", bytes([10, 20, 30]))
    if transparency is not None:
        result += chunk(b"tRNS", transparency)
    result += chunk(b"IDAT", zlib.compress((b"\0" + pixel * 256) * 64))
    return result + chunk(b"IEND", b"")


class InputTests(unittest.TestCase):
    def decode(self, data):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "atlas.png"
            path.write_bytes(data)
            return read_png(path)

    def test_opaque_rgb_rgba_and_indexed(self):
        for mode, pixel in [
            (2, bytes([10, 20, 30])),
            (6, bytes([10, 20, 30, 255])),
            (3, b"\0"),
        ]:
            with self.subTest(mode=mode):
                self.assertEqual(
                    self.decode(png(mode, pixel)), [(10, 20, 30)] * (256 * 64)
                )

    def test_nonopaque_rgba_rejected(self):
        for alpha in (0, 128, 254):
            with (
                self.subTest(alpha=alpha),
                self.assertRaisesRegex(ValueError, "Nonopaque RGBA"),
            ):
                self.decode(png(6, bytes([10, 20, 30, alpha])))

    def test_trns_rejected(self):
        for mode, pixel, transparency in [(2, b"\0\0\0", b"\0" * 6), (3, b"\0", b"\0")]:
            with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, "tRNS"):
                self.decode(png(mode, pixel, transparency))

    def test_metadata_contract(self):
        model = {
            "units_per_meter": 50,
            "attachments": {
                "machine_gun_left": {"direction": [0, 0, 1]},
                "machine_gun_right": {"direction": [0, 0, 1]},
            },
        }
        validate_authoring_options(model)
        model["units_per_meter"] = 100
        with self.assertRaisesRegex(ValueError, "units_per_meter"):
            validate_authoring_options(model)
        model["units_per_meter"] = 50
        model["attachments"]["machine_gun_right"]["direction"] = [1, 0, 0]
        with self.assertRaisesRegex(ValueError, "attachment direction"):
            validate_authoring_options(model)


if __name__ == "__main__":
    unittest.main()
