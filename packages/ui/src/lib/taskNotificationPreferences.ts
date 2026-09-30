const TASK_NOTIFICATION_ENABLED_STORAGE_KEY = "zcode-notification-enabled";
const TASK_NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = "zcode-notification-sound-enabled";

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    if (value == null) {
      return defaultValue;
    }

    return value !== "false";
  } catch {
    return defaultValue;
  }
}

function persistStoredBoolean(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // When localStorage is unavailable, it is silently ignored, allowing the main UI process to continue working.
  }
}

export function isTaskNotificationEnabled(): boolean {
  return readStoredBoolean(TASK_NOTIFICATION_ENABLED_STORAGE_KEY, true);
}

export function isTaskNotificationSoundPreferenceEnabled(): boolean {
  return readStoredBoolean(TASK_NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, true);
}

export function isTaskNotificationSoundEnabled(): boolean {
  // Notification sound is a sub-capability of task notification. Previously, when there was only one main switch,
  // The UI has no way of saying "keep desktop notifications but turn off the sound", and the runtime doesn't know that the sound must exist attached to the notification.
  // The sound preference is separated here, but when the final effective value is read, the notification master switch is still forced to be superimposed.
  // Ensure that the disabled state of the settings page is consistent with the actual playback behavior, and there will be no misalignment of "the notification is turned off but still sounds".
  return isTaskNotificationEnabled() && isTaskNotificationSoundPreferenceEnabled();
}

export function persistTaskNotificationEnabled(enabled: boolean): void {
  persistStoredBoolean(TASK_NOTIFICATION_ENABLED_STORAGE_KEY, enabled);
}

export function persistTaskNotificationSoundEnabled(enabled: boolean): void {
  persistStoredBoolean(TASK_NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, enabled);
}
