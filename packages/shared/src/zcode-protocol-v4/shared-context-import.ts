import { z } from "zod";

const sharedContextImportV2StateSchema = z
  .object({
    contextId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    shareUrl: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === "https:" || url.protocol === "http:") &&
            url.search === "" &&
            url.hash === "" &&
            /^\/cn\/share\/[^/]+$/u.test(url.pathname)
          );
        } catch {
          return false;
        }
      }, "shareUrl must use the canonical /cn/share/<code> path"),
    status: z.enum(["pending", "reserved", "attached", "discarded"]),
  })
  .strict();
// shareUrl is hard bound to /cn/share/<code>. In the future, change the domain name or use the English site /share/<code> as
// canonical, the persistence provenance of the existing session will fail to verify (local persistence, not wire, so it is not
// Within the scope of the discipline "Responsive Tolerance"). If you really want to change the canonical URL shape, you must first add a new shape to accept the old shape.
// The legacy branch of - follow the approach of legacySharedContextImportStateSchema.

const legacySharedContextImportStateSchema = z.object({ title: z.string().trim().min(1) }).strict();

export const sharedContextImportStateSchema = z.union([
  sharedContextImportV2StateSchema,
  legacySharedContextImportStateSchema,
]);

export type SharedContextImportState = z.infer<typeof sharedContextImportStateSchema>;
