import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";
import {
  ghCommandIsDangerous,
} from "./bash-readonly-policy-callbacks.js";

export const READONLY_MULTIWORD_POLICY_ENTRIES_CORE = [
  [
    "gh auth status",
    {
      safeFlags: {
        "-a": "none",
        "-h": "string",
        "--active": "none",
        "--hostname": "string",
        "--json": "string",
      },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
] as const satisfies readonly (readonly [string, BashReadonlyCommandPolicy])[];
