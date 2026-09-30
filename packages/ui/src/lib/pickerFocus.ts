export function isCoarseTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

export function shouldRestoreChatInputFocusAfterPickerClose({
  isCoarseTouchDevice: coarseTouch,
}: {
  isCoarseTouchDevice: boolean;
}): boolean {
  // After the mobile touch device closes the toolbar pop-up layer, if the focus continues to be returned to contenteditable,
  // The system soft keyboard will pop up again and block the remote control interface; the desktop still retains the keyboard flow that continues input after closing.
  return !coarseTouch;
}
