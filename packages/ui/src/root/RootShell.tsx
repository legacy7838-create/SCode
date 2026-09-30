import type { ReactNode } from "react";
import { AlertDialogHost } from "@/AlertDialogHost.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { CuaPermissionObservationAttachment } from "@/cua-permission/CuaPermissionObservationAttachment.js";

export function RootShell({ children }: { children: ReactNode }) {
  // Web remote control cannot be used in mobile browsers. Fixed 100vh.
  // Retracting the address bar will cause the bottom input area to be cut out of the viewport; the root node will use dynamic viewport height instead.
  return (
    <div className="relative h-dvh">
      {children}
      <CuaPermissionObservationAttachment />
      <AlertDialogHost />
      <ConfirmDialogHost />
    </div>
  );
}
