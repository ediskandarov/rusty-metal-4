#!/usr/bin/env python3
"""Prepare the pinned game sources and port patches without editing the submodule."""
import argparse
import io
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    build = (ROOT / 'build').resolve()
    if not output.is_relative_to(build) or output == build:
        parser.error('--output must be a directory inside build/')
    archive = subprocess.check_output([
        'git', '-C', str(ROOT / 'game'), 'archive', 'HEAD', 'src', 'include', 'config', 'tools'])
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as files:
        files.extractall(output, filter='data')
    for patch in sorted((ROOT / 'patches/game').glob('*.patch')):
        subprocess.run(['patch', '--batch', '--fuzz=0', '-E', '-p1', '-i', str(patch)],
                       cwd=output, check=True)


if __name__ == '__main__':
    main()
