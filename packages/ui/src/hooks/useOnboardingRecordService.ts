import { useServices } from "./useServices.js";

/**
 * The onboarding completion record service (persisted locally, uploaded to the server later). It
 * returns null when an old test double / an unsupported host has not registered the service, and
 * callers must null-check and degrade gracefully. Pure render tests with no ServiceProvider (where
 * the service is unrelated to the behavior under test) also get null instead of a throw —
 * useContext is called inside the try and runs on every render, so the hook call order stays
 * stable.
 */
export function useOnboardingRecordService() {
  try {
    const services = useServices();
    return services.onboardingRecordService ?? null;
  } catch {
    return null;
  }
}
