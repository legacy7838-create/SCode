import { z } from "zod";

// This schema is used by both the validation aggregation entry and the legacy protocol, so it must be placed in a leaf module with no reverse dependencies.
// Root cause: protocol imports it from validation, and validation imports protocol's resource sampling schema,
// ESM/Jiti in a clean environment would first read the not-yet-initialized binding, causing `.optional()` to crash at startup.
export const zcodeTaskModeSchema = z.enum(["yolo", "plan", "edit", "auto", "autoEdit", "build"]);
