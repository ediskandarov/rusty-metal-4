import { expect, test } from "bun:test";

import { resourceIndex, writeResourceIndex } from "@tm4/mr-preparation";

test("index creation and reading preserve disc sectors; only repack moves them", async () => {
  const text = await writeResourceIndex([
    { path: "/DATA/A.MR", sector: 900, size: 2049 },
    { path: "/DATA/MENU/B.TIM", sector: 20, size: 0 },
  ]);
  expect(text).toBe("900\t2049\t/DATA/A.MR\n20\t0\t/DATA/MENU/B.TIM\n");
  const index = await resourceIndex(text);
  try {
    expect(index.toTsv()).toBe(text);
    index.require("/DATA/A.MR", 2049);
    expect(() => index.require("/DATA/A.MR", 1)).toThrow("size differs");
    index.setSize("/DATA/A.MR", 4097);
    index.add("/DATA/MOD.MR", 0, 2);
    index.repack(1);
    expect(index.toTsv()).toBe("1\t4097\t/DATA/A.MR\n4\t0\t/DATA/MENU/B.TIM\n5\t2\t/DATA/MOD.MR\n");
  } finally {
    index.free();
  }
});

test("Wasm boundary rejects fractional, negative and overflowing JS numbers without coercion", async () => {
  const index = await resourceIndex("10\t1\t/DATA/A.MR\n");
  try {
    for (const value of [-1, 1.5, 2 ** 32, NaN, Infinity]) {
      expect(() => index.add("/DATA/B.MR", value, 1)).toThrow();
      expect(() => index.add("/DATA/B.MR", 1, value)).toThrow();
      expect(() => index.setSize("/DATA/A.MR", value)).toThrow();
      expect(() => index.repack(value)).toThrow();
      expect(() => index.require("/DATA/A.MR", value)).toThrow();
    }
    expect(index.toTsv()).toBe("10\t1\t/DATA/A.MR\n");
  } finally {
    index.free();
  }
});

test("index rejects malformed paths, duplicates and CD address overflow through Wasm", async () => {
  for (const text of [
    "1\t1\t/DATA/../X\n",
    "1\t1\t/DATA/X%20Y\n",
    "1\t1\t/DATA/A B\n",
    "1\t1\t/DATA/A\n2\t1\t/data/a\n",
    "449850\t1\t/DATA/A\n",
  ])
    await expect(resourceIndex(text)).rejects.toThrow();
  const index = await resourceIndex("10\t2049\t/data/a\n");
  try {
    expect(index.paths()).toEqual(["/DATA/A"]);
    expect(() => index.repack(449849)).toThrow("capacity");
    expect(index.toTsv()).toBe("10\t2049\t/DATA/A\n");
  } finally {
    index.free();
  }
});
