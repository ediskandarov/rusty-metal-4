import { z } from "zod";
export const text = (length: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(length)
    .refine(
      (value) =>
        [...value].every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      "Control characters are not allowed",
    );
