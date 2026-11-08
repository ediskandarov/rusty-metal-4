#!/usr/bin/env python3
"""Copy unchanged interleaved STR/XA sectors from the read-only original track."""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "game"))
from tools.overlay_resources import Disc


def prepare(track, output):
    output.mkdir(parents=True, exist_ok=True)
    disc = Disc(track)
    names = []
    try:
        for entry in disc.entries():
            path = Path(entry['original_path'].split(';')[0])
            if path.suffix != '.STR':
                continue
            disc.file.seek(entry['raw_track_offset'])
            remaining = entry['sector_count'] * 2352
            with (output / path.name).open('wb') as target:
                while remaining:
                    data = disc.file.read(min(remaining, 1024 * 1024))
                    if not data:
                        raise ValueError(f'Truncated movie: {path}')
                    target.write(data)
                    remaining -= len(data)
            names.append(path.stem)
    finally:
        disc.file.close()
    (output / 'prepared.txt').write_text('\n'.join(names) + '\n')
    print(f'Prepared {len(names)} unchanged STR/XA streams')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--track', required=True, type=Path)
    parser.add_argument('--output-directory', required=True, type=Path)
    args = parser.parse_args()
    prepare(args.track, args.output_directory)
