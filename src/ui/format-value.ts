const MAX_DEPTH = 6;

function indentation(depth: number): string {
  return "  ".repeat(depth);
}


function formatUnknown(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): string {
  try {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (typeof value === "bigint") return `${String(value)}n`;
    if (typeof value === "symbol") return String(value);
    if (typeof value === "function") {
      let name = "";
      try {
        name = value.name;
      } catch {
        // A callable proxy may reject property access.
      }
      return name ? `[Function ${name}]` : "[Function]";
    }
    if (typeof value !== "object") return String(value);
    if (ancestors.has(value)) return "[Circular]";
    if (depth >= MAX_DEPTH) return "[Object]";

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length === 0) return "[]";
        const items = value.map(
          (item) =>
            `${indentation(depth + 1)}${formatUnknown(item, depth + 1, ancestors)}`,
        );
        return `[\n${items.join(",\n")}\n${indentation(depth)}]`;
      }

      const keys = Object.keys(value);
      if (keys.length === 0) return "{}";
      const properties = keys.map((key) => {
        let property: unknown;
        try {
          property = (value as Record<string, unknown>)[key];
        } catch {
          property = "[Thrown while reading]";
        }
        const keyText = /^[A-Za-z_$][\w$]*$/u.test(key)
          ? key
          : JSON.stringify(key);
        return `${indentation(depth + 1)}${keyText}: ${formatUnknown(property, depth + 1, ancestors)}`;
      });
      return `{\n${properties.join(",\n")}\n${indentation(depth)}}`;
    } finally {
      ancestors.delete(value);
    }
  } catch {
    return "[Unformattable value]";
  }
}

export function formatValue(value: unknown): string {
  return formatUnknown(value, 0, new WeakSet<object>());
}
