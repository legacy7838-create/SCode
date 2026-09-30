import type { z } from "zod";

/** Each field keeps its original schema; only the defaults/nulls required for overrides are derived. Nested structures are derived explicitly by the caller. */
export function sparseShape<T extends Record<string, z.ZodType>>(shape: T) {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, schema.nullable().optional()]),
  ) as { [K in keyof T]: z.ZodOptional<z.ZodNullable<T[K]>> };
}
