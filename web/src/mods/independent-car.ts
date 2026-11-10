import type { MrDirectory, MrEntry } from "../compatibility/mr.ts";
import { readTimLayout } from "../compatibility/tim.ts";
import { stringEntry, stringValue } from "./mr-writer.ts";

export function requireKeys(d: MrDirectory, files: string[], folders: string[], context: string) {
  for (const name of d.files.keys())
    if (!files.includes(name)) throw new Error(`${context}: unsupported resource ${name}`);
  for (const name of d.folders.keys())
    if (!folders.includes(name)) throw new Error(`${context}: unsupported directory ${name}`);
}

function resource(d: MrDirectory, key: string, type: number, size?: number, count = 65535) {
  const e = d.files.get(key);
  if (
    !e ||
    e.type !== type ||
    e.arraySize !== count ||
    (size !== undefined && e.bytes.length !== size)
  )
    throw new Error(`Invalid or missing independent car resource: ${key}`);
  return e;
}

function view(e: MrEntry) {
  return new DataView(e.bytes.buffer, e.bytes.byteOffset, e.bytes.byteLength);
}

function integer(d: MrDirectory, key: string, type: number, min: number, max: number) {
  const value = view(resource(d, key, type, 4)).getInt32(0, true);
  if (value < min || value > max) throw new Error(`${key} outside ${min}–${max}`);
  return value;
}

function subdirectory(d: MrDirectory, key: string) {
  const value = d.folders.get(key);
  if (!value) throw new Error(`Missing independent car directory: ${key}`);
  return value;
}

function vector(v: DataView, offset: number) {
  return [0, 2, 4].map((axis) => v.getInt16(offset + axis, true));
}

function anchor(e: MrEntry, back: boolean) {
  const v = view(e);
  for (let offset = 0; offset < e.bytes.length; offset += 16) {
    const p = vector(v, offset);
    const d = vector(v, offset + 8);
    if (p.some((axis) => Math.abs(axis) > 1024))
      throw new Error("Car mount outside model coordinate range");
    if (Math.abs(Math.hypot(...d) - 4096) > 4 || (back ? d[2]! > -2048 : d[2]! < 2048))
      throw new Error("Car mount must use a normalized Q12 direction");
  }
}

// The engine tone payload contains just one looping mono PS1 ADPCM sample.
// The installer creates the fixed bank layout instead of accepting native VAB tables.
function engineSample(model: MrDirectory) {
  const bytes = resource(model, "engineSample", 3).bytes;
  if (bytes.length < 32 || bytes.length > 8192 || bytes.length % 16 !== 0)
    throw new Error("Invalid engineSample size");
  for (let i = 0; i < bytes.length; i += 16) {
    const control = bytes[i]!;
    const flags = i === 0 ? 6 : i === bytes.length - 16 ? 3 : 2;
    if (control >> 4 > 4 || (control & 15) > 12 || bytes[i + 1] !== flags)
      throw new Error("Invalid engineSample ADPCM block");
  }
  return bytes;
}

const tuning: [string, number, number, number][] = [
  ["massBottom", 13, 96, 768],
  ["massTop", 13, 64, 384],
  ["maxAxleTorque", 13, 8_000_000, 32_000_000],
  ["engineAxleFric", 13, 24_000, 65_536],
  ["frictionAdvantageFront", 13, 0, 4096],
  ["frictionAdvantageBack", 13, 0, 4096],
  ["turboEngineMultiplier", 13, 4096, 12288],
  ["turboEngineAxleFricMultiplier", 13, 4096, 12288],
  ["damageGiveFactor", 13, 512, 8192],
  ["damageReceiveFactor", 13, 512, 8192],
  ["physicsBoxHeight", 4, 20, 240],
  ["physicsBoxWidth", 4, 50, 420],
  ["physicsBoxLength", 4, 100, 700],
];
export const independentFiles = [
  "healthEnergyMax",
  "radarDotColor",
  "engineSample",
  "Laser",
  "info.tim",
];
export const independentFolders = ["physics", "special"];

export function checkIndependentCar(root: MrDirectory, display: MrDirectory) {
  const info = resource(root, "info.tim", 3).bytes;
  const layout = readTimLayout(info);
  if (
    layout.bitDepth !== 16 ||
    layout.clut ||
    layout.image.widthWords !== 320 ||
    layout.image.height !== 240
  )
    throw new Error("info.tim must be a 320×240 direct-color TIM");

  integer(root, "healthEnergyMax", 4, 4096, 32767);
  resource(root, "radarDotColor", 14, 4);
  engineSample(root);
  anchor(resource(root, "Laser", 26, 16, 1), false);

  const physics = subdirectory(root, "physics");
  requireKeys(physics, [...tuning.map(([key]) => key), "wheelDrive"], [], "Physics");
  for (const [key, type, min, max] of tuning) integer(physics, key, type, min, max);
  if (
    !["four wheel", "front wheel", "back wheel"].includes(
      stringValue(resource(physics, "wheelDrive", 2)),
    )
  )
    throw new Error("Invalid wheelDrive");

  const special = subdirectory(root, "special");
  requireKeys(
    special,
    ["name", "hudName", "launchFunc", "initial", "max", "delay", "regen"],
    [],
    "Special",
  );
  if (
    stringValue(resource(special, "name", 2)) !== "Laser" ||
    stringValue(resource(special, "launchFunc", 2)) !== "CarLaunchLaser"
  )
    throw new Error("Unsupported independent special weapon");
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,11}$/.test(stringValue(resource(special, "hudName", 2))))
    throw new Error("Invalid special weapon HUD name");
  const initial = integer(special, "initial", 4, 0, 8);
  const maximum = integer(special, "max", 4, 1, 8);
  if (initial > maximum) throw new Error("Special initial ammo exceeds its capacity");
  integer(special, "delay", 13, 1024, 32767);
  integer(special, "regen", 4, 5, 180);

  const guns = root.files.get("machineGuns");
  if (!guns) throw new Error("Missing machineGuns");
  anchor(guns, false);
  resource(display, "shadow", 3, 8);
  const turbo = subdirectory(display, "turbo");
  if (turbo.files.size !== 1) throw new Error("Turbo requires only one light mount");
  const light = vector(view(resource(turbo, "emmiter", 5, 8)), 0);
  if (light.some((axis) => Math.abs(axis) > 1024))
    throw new Error("Turbo light outside model coordinate range");
  if (turbo.folders.size < 1 || turbo.folders.size > 2)
    throw new Error("Turbo requires 1–2 exhaust outlets");
  for (const [key, outlet] of turbo.folders) {
    if (!/^[a-z][a-z0-9]{0,14}$/.test(key)) throw new Error("Invalid turbo outlet name");
    requireKeys(outlet, ["pos", "width", "length"], [], "Turbo outlet");
    anchor(resource(outlet, "pos", 15, 16), true);
    integer(outlet, "width", 4, 16, 64);
    integer(outlet, "length", 4, 16, 192);
  }
}

export function installEngineSound(model: MrDirectory, id: string) {
  const sample = engineSample(model);
  const name = `mod_${id}`;
  const names = new TextEncoder().encode(`${name}\r\n`);
  const program = 32;
  const tone = program + 128 * 16;
  const samples = tone + 16 * 32;
  const data = samples + 256 * 2;
  const length = data + sample.length;
  const bytes = new Uint8Array(Math.ceil((length + names.length) / 4) * 4);
  const bank = new DataView(bytes.buffer);
  bank.setUint32(0, 0x56414270, true);
  bank.setUint32(4, 7, true);
  bank.setUint32(12, length, true);
  for (const offset of [18, 20, 22]) bank.setUint16(offset, 1, true);
  bytes.set([127, 64], 24);
  bytes.set([1, 100, 0, 0, 64], program);
  bytes.set([8, 0, 69, 64, 82, 0, 0, 120, 0, 0, 0, 0, 1, 12], tone);
  bank.setUint16(tone + 16, 0x80ff, true);
  bank.setUint16(tone + 18, 0x5fc0, true);
  bank.setUint16(tone + 22, 1, true);
  bank.setUint16(samples + 2, sample.length / 8, true);
  bytes.set(sample, data);
  bytes.set(names, length);
  model.files.delete("engineSample");
  model.files.set("car.vab", { type: 16, arraySize: 65535, bytes });
  model.files.set("engineSoundName", stringEntry(name));
}
