import type { RandomSource } from "./types";

export const RESERVED_CELL_NAMES: Readonly<Record<string, true>> = {
  value: true,
  children: true,
  id: true,
  name: true,
  kind: true,
  text: true,
  peek: true,
  update: true,
  append: true,
  remove: true,
  replaceChildren: true,
};

const IDENTIFIER_PATTERN = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;

const ADJECTIVES = [
  "amber",
  "bright",
  "calm",
  "gentle",
  "quiet",
  "silver",
  "steady",
  "warm",
] as const;

const NOUNS = [
  "Cloud",
  "Fern",
  "Harbor",
  "Meadow",
  "River",
  "Sparrow",
  "Willow",
  "Zephyr",
] as const;

export type CellNameProblem = "invalid" | "reserved";

export type CellNameValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly problem: CellNameProblem };

export function validateCellName(name: string): CellNameValidation {
  if (!IDENTIFIER_PATTERN.test(name)) {
    return { valid: false, problem: "invalid" };
  }

  if (Object.hasOwn(RESERVED_CELL_NAMES, name)) {
    return { valid: false, problem: "reserved" };
  }

  return { valid: true };
}

export function isValidCellName(name: string): boolean {
  return validateCellName(name).valid;
}

export function generateCellName(
  existingNames: ReadonlySet<string>,
  random: RandomSource = Math.random,
): string {
  const candidateCount = ADJECTIVES.length * NOUNS.length;
  const sample = random();
  const normalizedSample = Number.isFinite(sample) ? Math.abs(sample) % 1 : 0;
  const startingIndex = Math.floor(normalizedSample * candidateCount);

  for (let offset = 0; offset < candidateCount; offset += 1) {
    const candidateIndex = (startingIndex + offset) % candidateCount;
    const adjective =
      ADJECTIVES[Math.floor(candidateIndex / NOUNS.length)] ?? ADJECTIVES[0];
    const noun = NOUNS[candidateIndex % NOUNS.length] ?? NOUNS[0];
    const candidate = `${adjective}${noun}`;

    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }

  const adjective =
    ADJECTIVES[Math.floor(startingIndex / NOUNS.length)] ?? ADJECTIVES[0];
  const noun = NOUNS[startingIndex % NOUNS.length] ?? NOUNS[0];
  const base = `${adjective}${noun}`;
  let suffix = 2;
  while (existingNames.has(`${base}${suffix}`)) {
    suffix += 1;
  }
  return `${base}${suffix}`;
}
