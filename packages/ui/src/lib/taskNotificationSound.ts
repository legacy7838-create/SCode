import taskNotificationPopUrl from "@/assets/notification-sounds/task-notification-pop.mp3";
import { isTaskNotificationSoundEnabled } from "@/lib/taskNotificationPreferences.js";

let taskNotificationAudio: HTMLAudioElement | null = null;

function getTaskNotificationAudio(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") {
    return null;
  }

  if (!taskNotificationAudio) {
    taskNotificationAudio = new Audio(taskNotificationPopUrl);
    taskNotificationAudio.preload = "auto";
  }

  return taskNotificationAudio;
}

export async function playTaskNotificationSound(): Promise<void> {
  // Desktop/Web will asynchronously trigger sound effect playback after "notification has been displayed";
  // If you no longer check the sound sub-switch here, the sound will continue to sound during operation after turning off the sound in the settings page.
  // It looks like the setting didn't take effect. Closing the final judgment to the player entrance ensures that all callers behave consistently.
  if (!isTaskNotificationSoundEnabled()) {
    return;
  }

  const audio = getTaskNotificationAudio();
  if (!audio) {
    return;
  }

  try {
    // When the same Audio instance is reused repeatedly in background notifications, if you do not return to the starting point first,
    // A new round of notifications will often go silent because they are still at the end of the last playback.
    // Here, the playback position is explicitly reset and the automatic playback limit exception is swallowed to prevent the sound effect failure from affecting the main notification link.
    audio.pause();
    audio.currentTime = 0;
    await audio.play();
  } catch {
    // The sound effect is an enhanced experience, and the main notification process will not be interrupted when playback fails.
  }
}
