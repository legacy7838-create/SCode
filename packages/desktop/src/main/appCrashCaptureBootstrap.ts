import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// Must be completed before appARMSBootstrap: first inject dataBaseDir by desktopEarlyDataBaseDirBootstrap, and then configure crashDumps.
// remoteCrashReporterEnabled=true means ARMS has taken over remote crash reporting and will no longer start the local-only crashReporter.
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger, true);
