const bundledLibModules = import.meta.glob<string>(
  "/node_modules/typescript/lib/lib.*.d.ts",
  {
    eager: true,
    import: "default",
    query: "?raw",
  },
);

export const BUNDLED_TYPESCRIPT_LIBS: ReadonlyMap<string, string> = new Map(
  Object.entries(bundledLibModules).map(([path, source]) => [
    `/${path.slice(path.lastIndexOf("/") + 1)}`,
    source,
  ]),
);
