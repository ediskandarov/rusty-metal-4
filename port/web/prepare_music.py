#!/usr/bin/env python3
"""Prepare lossless CDDA files and the disc TOC from a multi-file BIN/CUE image."""
import argparse
import json
from pathlib import Path
import re
import shutil


def read_cue(cue):
    tracks = []
    source = None
    for line in cue.read_text().splitlines():
        line = line.strip()
        if match := re.fullmatch(r'FILE "([^"]+)" BINARY', line):
            source = cue.parent / match[1]
        elif match := re.fullmatch(r'TRACK (\d+) (AUDIO|MODE2/2352)', line):
            if source is None or any(t['source'] == source for t in tracks):
                raise ValueError('Expected one track per BIN file')
            tracks.append(dict(number=int(match[1]), audio=match[2] == 'AUDIO', source=source))
        elif match := re.fullmatch(r'INDEX (00|01) (\d+):(\d+):(\d+)', line):
            if not tracks:
                raise ValueError('INDEX without a track')
            if match[1] == '01':
                tracks[-1]['index'] = (int(match[2]) * 60 + int(match[3])) * 75 + int(match[4])
        elif line and not line.startswith('REM '):
            raise ValueError(f'Unsupported CUE directive: {line}')
    start = 0
    for number, track in enumerate(tracks, 1):
        size = track['source'].stat().st_size
        if track['number'] != number or size % 2352 or 'index' not in track:
            raise ValueError('Invalid track numbering, sector size or INDEX 01')
        sectors = size // 2352
        if track['index'] >= sectors or track['audio'] != (number > 1):
            raise ValueError('Expected one data track followed by audio tracks')
        track.update(start=start, end=start+sectors, toc=(start+track['index']+150)//75*75-150)
        start += sectors
    if len(tracks) < 2:
        raise ValueError('No CD audio tracks')
    return tracks


def prepare(cue, directory, header):
    tracks = read_cue(cue)
    directory.mkdir(parents=True, exist_ok=True)
    for track in tracks[1:]:
        source = track['source']
        target = directory / f'track{track["number"]:02}.pcm'
        if not target.exists() or (target.stat().st_size, target.stat().st_mtime_ns) != (
                source.stat().st_size, source.stat().st_mtime_ns):
            shutil.copy2(source, target)
    leadout = (tracks[-1]['end'] + 150) // 75 * 75 - 150
    lines = ['/* Generated from the original CUE; all positions are CD logical sectors. */',
             f'#define WEB_MUSIC_TRACK_COUNT {len(tracks)}',
             'static const WebMusicTrack music_tracks[] = {', '    {0, 0, 0},']
    lines += [f'    {{{t["start"]}, {t["end"]}, {t["toc"]}}},' for t in tracks]
    lines += ['};', f'static const int music_leadout = {leadout};', '']
    header.parent.mkdir(parents=True, exist_ok=True)
    header.write_text('\n'.join(lines))
    (directory / 'tracks.json').write_text(json.dumps([
        {k:v for k,v in t.items() if k != 'source'} for t in tracks], indent=2)+'\n')
    print(f'Prepared {len(tracks)-1} unchanged stereo 44.1 kHz PCM tracks')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cue', type=Path, required=True)
    parser.add_argument('--output-directory', type=Path, required=True)
    parser.add_argument('--header', type=Path, required=True)
    args = parser.parse_args()
    prepare(args.cue, args.output_directory, args.header)
