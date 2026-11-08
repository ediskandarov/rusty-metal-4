#!/usr/bin/env python3
"""Generate differential cases by executing TM4's original square-root instructions."""
import argparse
import json
import random
import struct
from pathlib import Path


def signed(word):
    return word - 0x100000000 if word & 0x80000000 else word


def original_root(image, address, *arguments):
    base = struct.unpack_from('<I', image, 0x18)[0]
    regs = [0] * 32
    for index, value in enumerate(arguments):
        regs[4 + index] = value & 0xffffffff
    pc, delayed, leading = address, None, 0
    for _ in range(1024):
        if not pc:
            return regs[2]
        word = struct.unpack_from('<I', image, pc - base + 0x800)[0]
        opcode = word >> 26
        rs, rt, rd = (word >> 21) & 31, (word >> 16) & 31, (word >> 11) & 31
        sa, fn = (word >> 6) & 31, word & 63
        immediate = struct.unpack('<h', struct.pack('<H', word & 0xffff))[0]
        next_pc = pc + 4 if delayed is None else delayed
        delayed = None
        if opcode == 0:
            if fn == 0:
                regs[rd] = regs[rt] << sa
            elif fn == 2:
                regs[rd] = regs[rt] >> sa
            elif fn == 3:
                regs[rd] = signed(regs[rt]) >> sa
            elif fn == 4:
                regs[rd] = regs[rt] << (regs[rs] & 31)
            elif fn == 6:
                regs[rd] = regs[rt] >> (regs[rs] & 31)
            elif fn == 7:
                regs[rd] = signed(regs[rt]) >> (regs[rs] & 31)
            elif fn == 8:
                delayed = regs[rs]
            elif fn == 0x21:
                regs[rd] = regs[rs] + regs[rt]
            elif fn in (0x22, 0x23):
                regs[rd] = regs[rs] - regs[rt]
            elif fn == 0x24:
                regs[rd] = regs[rs] & regs[rt]
            elif fn == 0x25:
                regs[rd] = regs[rs] | regs[rt]
            elif fn == 0x2a:
                regs[rd] = int(signed(regs[rs]) < signed(regs[rt]))
            else:
                raise AssertionError(hex(word))
        elif opcode == 1 and rt == 0:
            if signed(regs[rs]) < 0:
                delayed = pc + 4 + immediate * 4
        elif opcode == 4:
            if regs[rs] == regs[rt]:
                delayed = pc + 4 + immediate * 4
        elif opcode == 5:
            if regs[rs] != regs[rt]:
                delayed = pc + 4 + immediate * 4
        elif opcode in (8, 9):
            regs[rt] = regs[rs] + immediate
        elif opcode == 12:
            regs[rt] = regs[rs] & (word & 0xffff)
        elif opcode == 15:
            regs[rt] = (word & 0xffff) << 16
        elif opcode == 18:
            if rs == 4 and rd == 30:
                bits = regs[rt] ^ (0xffffffff if regs[rt] & 0x80000000 else 0)
                leading = 32 - bits.bit_length()
            elif rs == 0 and rd == 31:
                regs[rt] = leading
            else:
                raise AssertionError(hex(word))
        elif opcode == 33:
            address = (regs[rs] + immediate) & 0xffffffff
            regs[rt] = struct.unpack_from('<h', image, address - base + 0x800)[0]
        else:
            raise AssertionError(hex(word))
        regs = [r & 0xffffffff for r in regs]
        regs[0] = 0
        pc = next_pc
    raise AssertionError(f'Root at {address:#x} did not return for {arguments}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original', type=Path, default=Path('orig/SCUS_945.60'))
    parser.add_argument('--output', type=Path, default=Path('build/web/sqrt-cases.json'))
    args = parser.parse_args()
    image = args.original.read_bytes()
    # Include bin boundaries at every normalization shift, zero/-1, and real AI cases.
    values = {0, -1, -1316355452, -1342785596, -1670161788, -1733884796,
              -1768849532, -1833283196, -1852072526, -1922443196, -2036586510, -2078357628}
    for shift in range(32):
        for high in range(-512, 513):
            for offset in (-1, 0, 1):
                value = (high << shift) + offset
                if -0x80000000 <= value <= 0x7fffffff:
                    values.add(value)
    rng = random.Random(94560)
    values.update(rng.randrange(-0x80000000, 0x80000000) for _ in range(10000))
    cases = {'SquareRoot0': [[value, original_root(image, 0x8003de48, value)]
                             for value in sorted(values)]}
    words = {0, 0xffffffff, 0x80000000, 0x7fffffff}
    for bit in range(32):
        words.update(((1 << bit) + delta) & 0xffffffff for delta in (-1, 0, 1))
    words.update(rng.getrandbits(32) for _ in range(2000))
    cases['SquareRootInt32'] = [[value, original_root(image, 0x80024bc4, value)]
                               for value in sorted(words)]
    pairs = {(high, low, shift)
             for high in (0, 1, 3, 0x7fffffff, 0x80000000, 0xffffffff)
             for low in (0, 1, 0x7fffffff, 0x80000000, 0xffffffff)
             for shift in (0, 1, 2, 12, 13, 18, 30, 32)}
    pairs.update((rng.getrandbits(32), rng.getrandbits(32), rng.choice((0, 12, 18)))
                 for _ in range(2000))
    cases['SquareRoot64Shifted'] = [[*args, original_root(image, 0x80024c24, *args)]
                                   for args in sorted(pairs)]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(cases))
    for name, entries in cases.items():
        print(f'Generated {len(entries)} cases from original {name} instructions and data')


if __name__ == '__main__':
    main()
