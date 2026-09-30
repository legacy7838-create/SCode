import type { LaunchMarks } from "@zcode/shared";

export function shouldReportLaunchToInput(state: {
  isStartupRenderBlocked: boolean;
  welcomeScreenOpen: boolean;
  alreadyReported: boolean;
}): boolean {
  // Access control clearing = RootStartupLoading exits and the input box is mounted; during welcome, although the access control is cleared, the login page is displayed and there is no input box, which does not count as "can input".
  return !state.alreadyReported && !state.isStartupRenderBlocked && !state.welcomeScreenOpen;
}

export function readRendererLaunchTimings(): {
  marks: LaunchMarks | null;
  rendererStart: number;
  reactCommit: number;
} | null {
  const w = window as Window & {
    __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null;
    __ZCODE_RENDERER_START__?: number;
    __ZCODE_REACT_COMMIT_AT__?: number;
  };
  const rendererStart = w.__ZCODE_RENDERER_START__;
  const reactCommit = w.__ZCODE_REACT_COMMIT_AT__;
  if (typeof rendererStart !== "number" || typeof reactCommit !== "number") {
    return null;
  }
  return { marks: w.__ZCODE_LAUNCH_MARKS__ ?? null, rendererStart, reactCommit };
}
