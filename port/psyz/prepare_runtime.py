#!/usr/bin/env python3
"""Apply maintained PsyZ fixes to a build-local source copy; keep the pin read-only."""
import argparse
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
shutil.copytree(args.source, args.output, dirs_exist_ok=True)
for patch in sorted((Path(__file__).parent / 'patches').glob('*.patch')):
    subprocess.run(['patch', '--batch', '-p1', '-i', str(patch.resolve())],
                   cwd=args.output, check=True)
