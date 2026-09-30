export type InterfaceMode = "office" | "coding";

export const INTERFACE_MODE_STORAGE_KEY = "zcode-interface-mode";

export function normalizeInterfaceMode(value: unknown): InterfaceMode {
  // The old value "general"/"concise" before the name change may still be stored in localStorage (zcode-interface-mode).
  // It must be mapped to the new name office, otherwise these existing users will be reclassified as coding after the upgrade, and their selection will be silently lost.
  return value === "office" || value === "general" || value === "concise" ? "office" : "coding";
}
