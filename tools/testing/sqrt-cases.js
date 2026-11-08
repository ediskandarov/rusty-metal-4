import { resolve } from "node:path";

import { options, write } from "../common.js";

function originalRoot(image, address, ...args) {
  const base = image.readUInt32LE(0x18);
  const registers = new Uint32Array(32);
  args.forEach((value, index) => {
    registers[index + 4] = value;
  });
  let pc = address,
    delayed = null,
    leading = 0;
  for (let step = 0; step < 1024; step++) {
    if (!pc) return registers[2];
    const word = image.readUInt32LE(pc - base + 0x800);
    const opcode = word >>> 26;
    const rs = (word >>> 21) & 31,
      rt = (word >>> 16) & 31,
      rd = (word >>> 11) & 31;
    const shift = (word >>> 6) & 31,
      operation = word & 63;
    const immediate = (word << 16) >> 16;
    const next = delayed ?? pc + 4;
    delayed = null;
    if (opcode === 0) {
      switch (operation) {
        case 0:
          registers[rd] = registers[rt] << shift;
          break;
        case 2:
          registers[rd] = registers[rt] >>> shift;
          break;
        case 3:
          registers[rd] = registers[rt] >> shift;
          break;
        case 4:
          registers[rd] = registers[rt] << (registers[rs] & 31);
          break;
        case 6:
          registers[rd] = registers[rt] >>> (registers[rs] & 31);
          break;
        case 7:
          registers[rd] = registers[rt] >> (registers[rs] & 31);
          break;
        case 8:
          delayed = registers[rs];
          break;
        case 0x21:
          registers[rd] = registers[rs] + registers[rt];
          break;
        case 0x22:
        case 0x23:
          registers[rd] = registers[rs] - registers[rt];
          break;
        case 0x24:
          registers[rd] = registers[rs] & registers[rt];
          break;
        case 0x25:
          registers[rd] = registers[rs] | registers[rt];
          break;
        case 0x2a:
          registers[rd] = Number((registers[rs] | 0) < (registers[rt] | 0));
          break;
        default:
          throw new Error(`Unsupported MIPS instruction: ${word.toString(16)}`);
      }
    } else if (opcode === 1 && rt === 0) {
      if ((registers[rs] | 0) < 0) delayed = pc + 4 + immediate * 4;
    } else if (opcode === 4) {
      if (registers[rs] === registers[rt]) delayed = pc + 4 + immediate * 4;
    } else if (opcode === 5) {
      if (registers[rs] !== registers[rt]) delayed = pc + 4 + immediate * 4;
    } else if (opcode === 8 || opcode === 9) {
      registers[rt] = registers[rs] + immediate;
    } else if (opcode === 12) {
      registers[rt] = registers[rs] & (word & 0xffff);
    } else if (opcode === 15) {
      registers[rt] = (word & 0xffff) << 16;
    } else if (opcode === 18 && rs === 4 && rd === 30) {
      const bits = registers[rt] ^ (registers[rt] & 0x80000000 ? 0xffffffff : 0);
      leading = Math.clz32(bits);
    } else if (opcode === 18 && rs === 0 && rd === 31) {
      registers[rt] = leading;
    } else if (opcode === 33) {
      const pointer = (registers[rs] + immediate) >>> 0;
      registers[rt] = image.readInt16LE(pointer - base + 0x800);
    } else throw new Error(`Unsupported MIPS instruction: ${word.toString(16)}`);
    registers[0] = 0;
    pc = next;
  }
  throw new Error(`Square root did not return: ${address.toString(16)}, ${args}`);
}

const args = options(["original", "output"]);
if (!args.original) throw new Error("Supply --original with your SCUS_945.60");
const image = Buffer.from(await Bun.file(args.original).arrayBuffer());
let seed = 94560;
function randomWord() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
}
const values = new Set([
  0, -1, -1316355452, -1342785596, -1670161788, -1733884796, -1768849532, -1833283196, -1852072526,
  -1922443196, -2036586510, -2078357628,
]);
for (let shift = 0; shift < 32; shift++) {
  for (let high = -512; high <= 512; high++) {
    for (const offset of [-1, 0, 1]) {
      const value = high * 2 ** shift + offset;
      if (value >= -0x80000000 && value <= 0x7fffffff) values.add(value);
    }
  }
}
for (let i = 0; i < 10000; i++) values.add(randomWord() | 0);
const words = new Set([0, 0xffffffff, 0x80000000, 0x7fffffff]);
for (let bit = 0; bit < 32; bit++)
  for (const delta of [-1, 0, 1]) words.add((2 ** bit + delta) >>> 0);
for (let i = 0; i < 2000; i++) words.add(randomWord());
const pairs = [];
for (const high of [0, 1, 3, 0x7fffffff, 0x80000000, 0xffffffff]) {
  for (const low of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff]) {
    for (const shift of [0, 1, 2, 12, 13, 18, 30, 32]) pairs.push([high, low, shift]);
  }
}
for (let i = 0; i < 2000; i++)
  pairs.push([randomWord(), randomWord(), [0, 12, 18][randomWord() % 3]]);
const cases = {
  SquareRoot0: [...values]
    .sort((a, b) => a - b)
    .map((value) => [value, originalRoot(image, 0x8003de48, value)]),
  SquareRootInt32: [...words]
    .sort((a, b) => a - b)
    .map((value) => [value, originalRoot(image, 0x80024bc4, value)]),
  SquareRoot64Shifted: pairs.map((pair) => [...pair, originalRoot(image, 0x80024c24, ...pair)]),
};
await write(resolve(args.output ?? "build/checks/sqrt-cases.json"), JSON.stringify(cases));
for (const [name, entries] of Object.entries(cases))
  console.log(`${name}: ${entries.length} original instruction results`);
