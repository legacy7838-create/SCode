import type { ZCodeSessionFile, ZCodeTaskMeta } from "@zcode/shared";
import { zcodeSessionFileSchema, zcodeTaskMetaSchema, zcodeTaskModeSchema } from "@zcode/shared";

export type LegacyTaskSessionFile = Omit<ZCodeSessionFile, "meta"> & {
  meta: Omit<ZCodeTaskMeta, "mode"> & { mode?: ZCodeTaskMeta["mode"] };
};

const legacyTaskSessionFileSchema = zcodeSessionFileSchema.extend({
  // Claude's native migration will delete meta.mode according to the cleaning path.
  // Legacy snapshot reads/writes still need to verify other required fields, but the filtered fields can no longer be forced to be added back to the file.
  meta: zcodeTaskMetaSchema.extend({
    mode: zcodeTaskModeSchema.optional(),
  }),
});

export function parseLegacyTaskSessionFile(input: unknown): LegacyTaskSessionFile {
  return legacyTaskSessionFileSchema.parse(input);
}

export function safeParseLegacyTaskSessionFile(input: unknown) {
  return legacyTaskSessionFileSchema.safeParse(input);
}
