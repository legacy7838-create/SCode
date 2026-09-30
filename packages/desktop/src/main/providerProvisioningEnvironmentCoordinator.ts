import type { ProviderProvisioningTrigger } from "@zcode/shared";

type ExecuteSync = (trigger: ProviderProvisioningTrigger) => Promise<void>;

interface Registration {
  readonly id: string;
  readonly execute: ExecuteSync;
}

interface EnvironmentLane {
  readonly registrations: Map<string, Registration>;
  generation: number;
  completedGeneration: number;
  trigger: ProviderProvisioningTrigger;
  drain: Promise<void> | null;
}

/**
 * The main process only coordinates the Environment identity and the execution generation; configuration and credentials are always read fresh and passed through by the selected Host.
 */
export class ProviderProvisioningEnvironmentCoordinator {
  readonly #lanes = new Map<string, EnvironmentLane>();

  register(
    environmentKey: string,
    registrationId: string,
    execute: ExecuteSync,
  ): {
    initialSync: Promise<void>;
    dispose(): void;
  } {
    const lane = this.#lanes.get(environmentKey) ?? createLane();
    const wasOffline = lane.registrations.size === 0;
    lane.registrations.set(registrationId, { id: registrationId, execute });
    this.#lanes.set(environmentKey, lane);
    if (wasOffline) {
      lane.generation += 1;
      lane.trigger = "environment-online";
    }
    const initialSync = this.#startDrain(lane);
    return {
      initialSync,
      dispose: () => {
        lane.registrations.delete(registrationId);
      },
    };
  }

  requestAll(trigger: Exclude<ProviderProvisioningTrigger, "environment-online">): Promise<void> {
    const drains: Promise<void>[] = [];
    for (const lane of this.#lanes.values()) {
      lane.generation += 1;
      lane.trigger = trigger;
      if (lane.registrations.size > 0) drains.push(this.#startDrain(lane));
    }
    return Promise.all(drains).then(() => undefined);
  }

  #startDrain(lane: EnvironmentLane): Promise<void> {
    if (lane.drain) return lane.drain;
    const operation = this.#drain(lane).finally(() => {
      if (lane.drain === operation) lane.drain = null;
    });
    lane.drain = operation;
    return operation;
  }

  async #drain(lane: EnvironmentLane): Promise<void> {
    while (lane.completedGeneration < lane.generation && lane.registrations.size > 0) {
      const targetGeneration = lane.generation;
      const trigger = lane.trigger;
      const registration = lane.registrations.values().next().value as Registration | undefined;
      if (!registration) return;
      try {
        await registration.execute(trigger);
        lane.completedGeneration = targetGeneration;
      } catch (error) {
        // When executing Host to exit, its registration will be removed first; there are still other Hosts in the same Environment
        // Take over the current generation immediately. Ordinary remote failures do not automatically retry and wait for the next official trigger.
        if (!lane.registrations.has(registration.id) && lane.registrations.size > 0) continue;
        lane.completedGeneration = targetGeneration;
        // The first synchronization is the Remote Workspace release barrier, and failure cannot be swallowed as ready;
        // The synchronization after connection is downgraded from execution side to warning and will not enter here.
        if (trigger === "environment-online") throw error;
      }
    }
  }
}

function createLane(): EnvironmentLane {
  return {
    registrations: new Map(),
    generation: 0,
    completedGeneration: 0,
    trigger: "environment-online",
    drain: null,
  };
}
