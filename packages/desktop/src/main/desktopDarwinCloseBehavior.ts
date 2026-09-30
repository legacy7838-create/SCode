interface DarwinCloseAwareWindow {
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  hide(): void;
}

export function handleDarwinWindowCloseRequest(options: {
  win: DarwinCloseAwareWindow;
  forceQuit: boolean;
  label: string;
  logger: { info: (...args: unknown[]) => void };
}): boolean {
  if (options.forceQuit) {
    return false;
  }

  if (options.win.isFullScreen()) {
    // The native full screen of macOS will occupy a separate Space. Previously, the "red dot = hidden window" was still used here.
    // Directly using hide() in full-screen mode will hide the window in the full-screen Space. What the user sees is a black screen, but the window is not actually closed.
    // Here it is changed to exit the full screen first and let "click close" return to the normal window in the full screen scene to avoid leaving a black screen Space.
    options.win.setFullScreen(false);
    options.logger.info(
      `[createWindow] fullscreen close converted to leave-full-screen (${options.label})`,
    );
    return true;
  }

  options.win.hide();
  options.logger.info(`[createWindow] window hidden instead of closed (${options.label})`);
  return true;
}
