"""CDDA preparation must preserve sectors, pregaps and exact PCM bytes."""
from pathlib import Path
import tempfile
import unittest

from prepare_music import prepare, read_cue


class MusicInputTests(unittest.TestCase):
    def fixture(self, root):
        for name, sectors, byte in [('data.bin', 101, 0), ('one.bin', 230, 1), ('two.bin', 300, 2)]:
            (root / name).write_bytes(bytes([byte]) * sectors * 2352)
        cue = root / 'disc.cue'
        cue.write_text('''FILE "data.bin" BINARY
 TRACK 01 MODE2/2352
 INDEX 01 00:00:00
FILE "one.bin" BINARY
 TRACK 02 AUDIO
 INDEX 00 00:00:00
 INDEX 01 00:02:00
FILE "two.bin" BINARY
 TRACK 03 AUDIO
 INDEX 00 00:00:00
 INDEX 01 00:02:00
''')
        return cue

    def test_sector_map_and_sdk_toc_rounding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tracks = read_cue(self.fixture(root))
            self.assertEqual([(t['start'], t['end'], t['toc']) for t in tracks],
                             [(0, 101, 0), (101, 331, 225), (331, 631, 450)])
            self.assertEqual([t['index'] for t in tracks], [0, 150, 150])

    def test_pcm_unchanged_including_pregap(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            prepare(self.fixture(root), root/'audio', root/'tracks.h')
            for number, source in [(2, 'one.bin'), (3, 'two.bin')]:
                self.assertEqual((root/'audio'/f'track{number:02}.pcm').read_bytes(),
                                 (root/source).read_bytes())
            header = (root/'tracks.h').read_text()
            self.assertIn('WEB_MUSIC_TRACK_COUNT 3', header)
            self.assertIn('music_leadout = 600', header)
            self.assertNotIn(str(root), header)

    def test_reject_nonsector_file_and_missing_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cue = self.fixture(root)
            (root/'one.bin').write_bytes(b'not a sector')
            with self.assertRaises(ValueError):
                read_cue(cue)
            cue = self.fixture(root)
            cue.write_text(cue.read_text().replace('INDEX 01 00:02:00', ''))
            with self.assertRaises(ValueError):
                read_cue(cue)


if __name__ == '__main__':
    unittest.main()
