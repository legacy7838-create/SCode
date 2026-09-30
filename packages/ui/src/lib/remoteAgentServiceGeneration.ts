// Remote workspace service proxy's renderer-local monotonic generation.
// The session registration entry is pre-allocated first, and the asynchronous consumer then reads the same generation according to the object identity to avoid effect switching back out of order.
const generations = new WeakMap<object, number>();
let nextGeneration = 1;

export function remoteAgentServiceGeneration(agentService: object): number {
  const existing = generations.get(agentService);
  if (existing !== undefined) return existing;

  const generation = nextGeneration++;
  generations.set(agentService, generation);
  return generation;
}
