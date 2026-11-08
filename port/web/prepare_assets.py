#!/usr/bin/env python3
"""Copy data assets from the read-only game disc into the ignored WASM package."""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "game"))
from tools.overlay_resources import Disc

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--track', required=True, type=Path)
parser.add_argument('--output-directory', required=True, type=Path)
args = parser.parse_args()
disc = Disc(args.track)
manifest = []
try:
    for entry in disc.entries():
        path = entry['original_path'].split(';')[0]
        if not path.startswith('/DATA/') or Path(path).suffix not in {'.MR', '.IMG', '.TIM', '.VAB'}:
            continue
        data, _ = disc.read(entry['lba'], entry['size'])
        output = args.output_directory / path.removeprefix('/DATA/')
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)
        manifest.append(f"{entry['lba']}\t{len(data)}\t{path}\n")
finally:
    disc.file.close()
(args.output_directory / 'files.tsv').write_text(''.join(manifest))
print(f'Prepared {len(manifest)} original resources for the browser')
