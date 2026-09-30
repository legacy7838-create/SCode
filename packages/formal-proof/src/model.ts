export type RunPhase = "idle" | "running" | "completed" | "compacting" | "goalVerifying";
export type QueueState = "empty" | "text" | "goal" | "compact" | "mixed";
export type CompactMemory = "never" | "compactable" | "justCompacted" | "notNeeded";
export type GoalState = "none" | "active" | "verifying" | "verified" | "failed";
export type TurnTarget = "latest" | "old" | "none";
export type CandidateKind = "user" | "system";
// The held status input is not queued silently.
// It is up to the user to select "clear the queue and then send/keep the queue and send immediately".
export type DecisionKind = "allow" | "reject" | "enqueue" | "choice" | "system" | "undefined";
export type NodeKind = "state" | "candidate" | "guard" | "effect" | "case" | "summary";

export interface ProductContext {
  readonly runPhase: RunPhase;
  readonly queue: QueueState;
  readonly compactMemory: CompactMemory;
  readonly canCompactAgain: boolean;
  readonly goal: GoalState;
  readonly selectedTurn: TurnTarget;
  readonly forked: boolean;
}

export interface Candidate {
  readonly id: string;
  readonly kind: CandidateKind;
  readonly label: string;
  readonly target: TurnTarget;
  readonly surface: string;
}

export interface Decision {
  readonly kind: DecisionKind;
  readonly ruleId: string;
  readonly title: string;
  readonly reason: string;
  readonly next?: ProductContext;
  readonly assertion: string;
}

export interface TraceNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string;
  readonly context: ProductContext;
  readonly candidate?: Candidate;
  readonly decision?: Decision;
  readonly caseId?: string;
  readonly e2e?: string;
  readonly children: TraceNode[];
}

export interface TraceStats {
  readonly nodes: number;
  readonly cases: number;
  readonly rejects: number;
  readonly undefined: number;
  readonly enqueued: number;
  readonly allowed: number;
  readonly choices: number;
  readonly system: number;
}

export interface ModelProfile {
  readonly id: string;
  readonly label: string;
  readonly context: ProductContext;
}

export const profiles: ModelProfile[] = [
  {
    id: "running",
    label: "running: sending a message",
    context: {
      runPhase: "running",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "completed",
    label: "completed: message finished",
    context: {
      runPhase: "completed",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "goal-verifying",
    label: "goalVerifying: verifying the goal",
    context: {
      runPhase: "goalVerifying",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "verifying",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "compacting",
    label: "compacting: compacting",
    context: {
      runPhase: "compacting",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "just-compacted-noop",
    label: "justCompacted: just compacted, no need to compact again",
    context: {
      runPhase: "completed",
      queue: "empty",
      compactMemory: "justCompacted",
      canCompactAgain: false,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "just-compacted-more",
    label: "justCompacted: just compacted, but can compact again",
    context: {
      runPhase: "completed",
      queue: "empty",
      compactMemory: "justCompacted",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
];

export const userCandidates: Candidate[] = [
  { id: "sendText", kind: "user", label: "Keep sending text", target: "none", surface: "composer" },
  { id: "slashCompact", kind: "user", label: "Type /compact", target: "none", surface: "composer" },
  { id: "setGoal", kind: "user", label: "Set a goal", target: "none", surface: "goal control" },
  { id: "compact", kind: "user", label: "Click compact", target: "none", surface: "toolbar" },
  {
    id: "forkLatest",
    kind: "user",
    label: "Fork the latest turn",
    target: "latest",
    surface: "turn actions",
  },
  {
    id: "forkOld",
    kind: "user",
    label: "Fork an older turn",
    target: "old",
    surface: "turn actions",
  },
  {
    id: "editLatest",
    kind: "user",
    label: "Edit the latest query",
    target: "latest",
    surface: "message actions",
  },
  {
    id: "editOld",
    kind: "user",
    label: "Edit an older query",
    target: "old",
    surface: "message actions",
  },
];

const systemCandidates: Candidate[] = [
  {
    id: "assistantComplete",
    kind: "system",
    label: "assistant finishes the current run",
    target: "none",
    surface: "runtime event",
  },
  {
    id: "compactComplete",
    kind: "system",
    label: "compact completes",
    target: "none",
    surface: "runtime event",
  },
  {
    id: "compactNoop",
    kind: "system",
    label: "compact decides not to continue",
    target: "none",
    surface: "runtime event",
  },
  {
    id: "goalVerifyStart",
    kind: "system",
    label: "Start goal verification",
    target: "none",
    surface: "goal runtime",
  },
  {
    id: "goalVerifyPass",
    kind: "system",
    label: "goal verification passes",
    target: "none",
    surface: "goal runtime",
  },
  {
    id: "goalVerifyFail",
    kind: "system",
    label: "goal verification fails",
    target: "none",
    surface: "goal runtime",
  },
];

let nextNodeId = 0;
let nextCaseId = 0;

export function resetIds(): void {
  nextNodeId = 0;
  nextCaseId = 0;
}

export function contextLabel(context: ProductContext): string {
  return [
    `phase=${context.runPhase}`,
    `queue=${context.queue}`,
    `compact=${context.compactMemory}`,
    context.canCompactAgain ? "canCompactAgain" : "cannotCompactAgain",
    `goal=${context.goal}`,
    `turn=${context.selectedTurn}`,
    context.forked ? "forked" : "notForked",
  ].join(" / ");
}

export function contextKey(context: ProductContext): string {
  return [
    context.runPhase,
    context.queue,
    context.compactMemory,
    String(context.canCompactAgain),
    context.goal,
    context.selectedTurn,
    String(context.forked),
  ].join("|");
}

export function enumerateCandidates(context: ProductContext): Candidate[] {
  const events = systemCandidates.filter((candidate) =>
    isSystemCandidateApplicable(context, candidate),
  );
  return [...userCandidates, ...events];
}

export function buildTraceTree(context: ProductContext, maxRounds: number): TraceNode {
  resetIds();
  return buildStateNode(context, 1, maxRounds, new Map());
}

export function collectStats(root: TraceNode): TraceStats {
  const stats = {
    nodes: 0,
    cases: 0,
    rejects: 0,
    undefined: 0,
    enqueued: 0,
    allowed: 0,
    choices: 0,
    system: 0,
  };

  visit(root, (node) => {
    stats.nodes += 1;
    if (node.kind === "case") {
      stats.cases += 1;
    }
    if (node.decision?.kind === "reject") {
      stats.rejects += 1;
    }
    if (node.decision?.kind === "undefined") {
      stats.undefined += 1;
    }
    if (node.decision?.kind === "enqueue") {
      stats.enqueued += 1;
    }
    if (node.decision?.kind === "allow") {
      stats.allowed += 1;
    }
    if (node.decision?.kind === "choice") {
      stats.choices += 1;
    }
    if (node.decision?.kind === "system") {
      stats.system += 1;
    }
  });

  return stats;
}

export function flatten(root: TraceNode): TraceNode[] {
  const nodes: TraceNode[] = [];
  visit(root, (node) => nodes.push(node));
  return nodes;
}

export function decisionLabel(decision: Decision): string {
  if (decision.kind === "reject") {
    return `reject · ${decision.title}`;
  }
  if (decision.kind === "enqueue") {
    return `enqueue · ${decision.title}`;
  }
  if (decision.kind === "allow") {
    return `allow · ${decision.title}`;
  }
  if (decision.kind === "choice") {
    return `choice · ${decision.title}`;
  }
  if (decision.kind === "system") {
    return `system · ${decision.title}`;
  }
  return `undefined · ${decision.title}`;
}

function visit(node: TraceNode, fn: (node: TraceNode) => void): void {
  fn(node);
  for (const child of node.children) {
    visit(child, fn);
  }
}

function buildStateNode(
  context: ProductContext,
  round: number,
  maxRounds: number,
  seen: Map<string, number>,
): TraceNode {
  const node = makeNode({
    kind: "state",
    title: `S${round}: ${context.runPhase}`,
    subtitle: contextLabel(context),
    detail:
      "The visible product context. The next level enumerates the Cartesian product of all candidate actions, then prunes it with product guards.",
    context,
    children: [],
  });

  if (round > maxRounds) {
    return makeCaseNode(
      node,
      "Reached the round limit",
      "This trace has reached the current enumeration depth and needs a manual review of whether to keep expanding.",
    );
  }

  const loopKey = `${round}:${contextKey(context)}`;
  const visited = seen.get(loopKey) ?? 0;
  if (visited > 1) {
    return makeCaseNode(
      node,
      "Repeated context",
      "The model reached the same context again; this is where it should decide whether to merge it into an equivalence class.",
    );
  }
  const nextSeen = new Map(seen);
  nextSeen.set(loopKey, visited + 1);

  node.children.push(
    ...enumerateCandidates(context).map((candidate) =>
      buildCandidateNode(context, candidate, round, maxRounds, nextSeen),
    ),
  );
  return node;
}

function buildCandidateNode(
  context: ProductContext,
  candidate: Candidate,
  round: number,
  maxRounds: number,
  seen: Map<string, number>,
): TraceNode {
  const decision = evaluate(context, candidate);
  const candidateNode = makeNode({
    kind: "candidate",
    title: candidate.label,
    subtitle: `${candidate.kind} / ${candidate.surface}`,
    detail: `Candidate combination: ${contextLabel(context)} × ${candidate.label}`,
    context,
    candidate,
    children: [],
  });
  const guardNode = makeNode({
    kind: "guard",
    title: decisionLabel(decision),
    subtitle: decision.ruleId,
    detail: decision.reason,
    context,
    candidate,
    decision,
    children: [],
  });
  const effectNode = makeNode({
    kind: "effect",
    title: effectTitle(decision),
    subtitle: decision.assertion,
    detail: decision.next
      ? contextLabel(decision.next)
      : "No next state: the path is pruned here or is waiting for a product definition.",
    context: decision.next ?? context,
    candidate,
    decision,
    children: [],
  });

  // Choice does not expand the next state: clear/keep. Both dispositions end up in the completedCanSend path.
  if (
    decision.next &&
    decision.kind !== "reject" &&
    decision.kind !== "undefined" &&
    decision.kind !== "choice"
  ) {
    effectNode.children.push(buildStateNode(decision.next, round + 1, maxRounds, seen));
  } else {
    effectNode.children.push(
      makeCaseNode(effectNode, decision.title, decision.assertion, candidate, decision),
    );
  }

  guardNode.children.push(effectNode);
  candidateNode.children.push(guardNode);
  return candidateNode;
}

function makeCaseNode(
  base: TraceNode,
  title: string,
  detail: string,
  candidate?: Candidate,
  decision?: Decision,
): TraceNode {
  nextCaseId += 1;
  const caseId = `CASE-${String(nextCaseId).padStart(5, "0")}`;
  return makeNode({
    kind: "case",
    title: caseId,
    subtitle: title,
    detail,
    context: base.context,
    candidate,
    decision,
    caseId,
    e2e: buildE2eAssertion(base.context, candidate, decision),
    children: [],
  });
}

function makeNode(input: Omit<TraceNode, "id">): TraceNode {
  nextNodeId += 1;
  return {
    ...input,
    id: `n-${nextNodeId}`,
  };
}

function effectTitle(decision: Decision): string {
  if (decision.kind === "reject") {
    return "Prune: show an explicit rejection";
  }
  if (decision.kind === "enqueue") {
    return "Effect: enters the message queue";
  }
  if (decision.kind === "allow") {
    return "Effect: the action takes effect";
  }
  if (decision.kind === "system") {
    return "System event: advances the phase";
  }
  if (decision.kind === "choice") {
    return "Blocked: waiting for the user to decide the queue disposition";
  }
  return "Undefined: needs a product review";
}

// Export as an executable ruling table (02-projection "Rule module sinking"):
// The guard derivation of the CLI projection must be consistent with this function one by one, as determined by the bootstrap
// formal-proof-consistency Gold Test Mechanical Endorsement.
export function evaluate(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.kind === "system") {
    return evaluateSystem(context, candidate);
  }

  if (context.runPhase === "running") {
    return evaluateRunning(context, candidate);
  }
  if (context.runPhase === "compacting") {
    return evaluateCompacting(context, candidate);
  }
  if (context.runPhase === "goalVerifying") {
    return evaluateGoalVerifying(context, candidate);
  }
  if (context.runPhase === "completed") {
    return evaluateCompleted(context, candidate);
  }
  return evaluateIdle(context, candidate);
}

function evaluateRunning(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "sendText") {
    return enqueue(
      context,
      candidate,
      "queueTextWhileRunning",
      "While running, further text input enters the message queue.",
    );
  }
  if (candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "queueGoalWhileRunning",
      "While running, setting a goal enters the message queue.",
    );
  }
  if (candidate.id === "slashCompact" || candidate.id === "compact") {
    return enqueue(
      context,
      candidate,
      "runningCompactQueues",
      "While running, compact enters the FIFO as a maintenance intent.",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "runningCannotFork",
      "Cannot fork while running",
      "Neither the latest turn nor an older turn can be forked.",
    );
  }
  if (candidate.id === "editLatest" || candidate.id === "editOld") {
    return reject(
      context,
      "runningCannotEditQuery",
      "Cannot edit a query while running",
      "While sending, neither the latest query nor historical queries can be edited.",
    );
  }
  return undefinedDecision(context, candidate, "runningUnhandled");
}

function evaluateCompacting(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return reject(
      context,
      "compactingCannotCompact",
      "Already compacting, cannot compact again",
      "The entry point must be deduplicated or disabled.",
    );
  }
  // Re-ruling (compactingAcceptsFutureInput):
  // compact is a maintenance step, user input is future intention → enqueuing, compact is not interrupted.
  if (candidate.id === "sendText" || candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "compactingAcceptsFutureInput",
      "While compacting, input is appended to the queue without interrupting the compact.",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "compactingCannotFork",
      "Already compacting, cannot fork",
      "Avoid forking into a half-compacted context.",
    );
  }
  return undefinedDecision(context, candidate, "compactingUnhandled");
}

function evaluateGoalVerifying(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return enqueue(
      context,
      candidate,
      "goalVerifierAcceptsFutureInput",
      "During goal verification, compact is appended to the queue without interrupting the verification.",
    );
  }
  if (candidate.id === "sendText" || candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "goalVerifierAcceptsFutureInput",
      "During goal verification, input is appended to the queue without interrupting the verification.",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "goalVerifyingCannotFork",
      "Cannot fork during goal verification",
      "Forking during the verification phase breaks result attribution.",
    );
  }
  return undefinedDecision(context, candidate, "goalVerifyingUnhandled");
}

function evaluateCompleted(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return allow(context, "completedCanFork", "Can fork after completion", {
      ...context,
      forked: true,
      selectedTurn: candidate.target,
    });
  }
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    if (context.queue !== "empty") {
      return enqueue(
        context,
        candidate,
        "heldCompactQueues",
        "With a held queue, compact is appended to the tail without bypassing the future intent.",
      );
    }
    if (context.compactMemory === "justCompacted" && !context.canCompactAgain) {
      return reject(
        context,
        "justCompactedNoNeed",
        "Just compacted, no need to compact",
        "compact can still be clicked, but the model returns a noop hint.",
      );
    }
    return allow(context, "completedCanCompact", "Can compact after completion", {
      ...context,
      runPhase: "compacting",
      compactMemory: "compactable",
    });
  }
  // held judgment: The queue that is still stuck under completed can only be the held queue with autoDrain=false
  // (When autoDrain=true, assistantComplete is consumed, and completed+queue>0 does not persist).
  // Re-judgment (heldQueueInputRequiresChoice, replacing the original heldQueueCapturesNewInput):
  // Input under held is not silently queued, and is sent after the user selects clear/keep queue.
  if (candidate.id === "sendText") {
    if (context.queue !== "empty") {
      return choice(
        context,
        "heldQueueInputRequiresChoice",
        "Sending with a held queue requires a user decision",
        'Shows "send after clearing the queue / send now keeping the queue"; the disposition travels up with the command.',
      );
    }
    return allow(context, "completedCanSend", "Can keep sending after completion", {
      ...context,
      runPhase: "running",
      queue: "empty",
    });
  }
  if (candidate.id === "setGoal") {
    if (context.queue !== "empty") {
      return choice(
        context,
        "heldQueueInputRequiresChoice",
        "Setting a goal with a held queue requires a user decision",
        "Same as sendText: composer input always goes through a choice.",
      );
    }
    return allow(context, "completedCanSetGoal", "Can set a goal after completion", {
      ...context,
      goal: "active",
    });
  }
  return undefinedDecision(context, candidate, "completedUnhandled");
}

function evaluateIdle(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "sendText") {
    return allow(context, "idleCanSend", "Sends a message while idle", {
      ...context,
      runPhase: "running",
      queue: "empty",
    });
  }
  if (candidate.id === "setGoal") {
    return allow(context, "idleCanSetGoal", "Sets a goal while idle", {
      ...context,
      goal: "active",
    });
  }
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return reject(
      context,
      "idleCannotCompact",
      "No compactable context",
      "With no finished message, compact should be disabled or prompt.",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "idleCannotFork",
      "No forkable turn",
      "With no finished turn, fork should be disabled.",
    );
  }
  if (candidate.id === "editLatest" || candidate.id === "editOld") {
    return reject(
      context,
      "idleCannotEdit",
      "No editable query",
      "With no query, the edit entry point should not appear.",
    );
  }
  return undefinedDecision(context, candidate, "idleUnhandled");
}

function evaluateSystem(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "assistantComplete") {
    return systemTransition(
      context,
      "assistantComplete",
      "assistant completes",
      drainQueueAfterRun(context),
    );
  }
  if (candidate.id === "compactComplete") {
    return systemTransition(context, "compactComplete", "compact completes", {
      ...context,
      runPhase: "completed",
      compactMemory: "justCompacted",
      canCompactAgain: true,
    });
  }
  if (candidate.id === "compactNoop") {
    return systemTransition(context, "compactNoop", "compact decides not to compact again", {
      ...context,
      runPhase: "completed",
      compactMemory: "justCompacted",
      canCompactAgain: false,
    });
  }
  if (candidate.id === "goalVerifyStart") {
    return systemTransition(context, "goalVerifyStart", "Enters goal verification", {
      ...context,
      runPhase: "goalVerifying",
      goal: "verifying",
    });
  }
  if (candidate.id === "goalVerifyPass") {
    return systemTransition(context, "goalVerifyPass", "goal verification passes", {
      ...context,
      runPhase: "completed",
      goal: "verified",
    });
  }
  return systemTransition(context, "goalVerifyFail", "goal verification fails", {
    ...context,
    runPhase: "completed",
    goal: "failed",
  });
}

function isSystemCandidateApplicable(context: ProductContext, candidate: Candidate): boolean {
  if (candidate.id === "assistantComplete") {
    return context.runPhase === "running";
  }
  if (candidate.id === "compactComplete" || candidate.id === "compactNoop") {
    return context.runPhase === "compacting";
  }
  if (candidate.id === "goalVerifyStart") {
    return context.runPhase === "completed" && context.goal === "active";
  }
  if (candidate.id === "goalVerifyPass" || candidate.id === "goalVerifyFail") {
    return context.runPhase === "goalVerifying";
  }
  return false;
}

function allow(
  context: ProductContext,
  ruleId: string,
  title: string,
  next: ProductContext,
): Decision {
  return {
    kind: "allow",
    ruleId,
    title,
    reason: title,
    next,
    assertion:
      "The action takes effect, and the UI, message attribution, button state and next context stay consistent.",
  };
}

function enqueue(
  context: ProductContext,
  candidate: Candidate,
  ruleId: string,
  reason: string,
): Decision {
  const queued =
    candidate.id === "setGoal"
      ? "goal"
      : candidate.id === "compact" || candidate.id === "slashCompact"
        ? "compact"
        : "text";
  return {
    kind: "enqueue",
    ruleId,
    title:
      queued === "goal"
        ? "goal enqueued"
        : queued === "compact"
          ? "compact enqueued"
          : "text message enqueued",
    reason,
    next: {
      ...context,
      queue: mergeQueue(context.queue, queued),
    },
    assertion:
      queued === "goal"
        ? "The goal intent must be preserved in the queue."
        : queued === "compact"
          ? "The compact maintenance intent must be preserved in the queue, and no user row may be created."
          : "The user's text message must be preserved in the queue.",
  };
}

function choice(context: ProductContext, ruleId: string, title: string, reason: string): Decision {
  return {
    kind: "choice",
    ruleId,
    title,
    reason,
    // None next: The status will not be advanced until the user submits the disposition (clear/keep will end at startNow).
    next: context,
    assertion:
      "An explicit choice must be presented; nothing may be enqueued or sent before the user decides.",
  };
}

function reject(context: ProductContext, ruleId: string, title: string, reason: string): Decision {
  return {
    kind: "reject",
    ruleId,
    title,
    reason,
    assertion:
      "This path must show explicit feedback and must not produce the forbidden side effect.",
    next: context,
  };
}

function systemTransition(
  context: ProductContext,
  ruleId: string,
  title: string,
  next: ProductContext,
): Decision {
  return {
    kind: "system",
    ruleId,
    title,
    reason: "A system async event advances the product state.",
    next,
    assertion:
      "The system event must be persisted under the current session/run and must not pollute other traces.",
  };
}

function undefinedDecision(
  context: ProductContext,
  candidate: Candidate,
  ruleId: string,
): Decision {
  return {
    kind: "undefined",
    ruleId,
    title: "Product expectation is undefined",
    reason: `The model does not know whether ${context.runPhase} + ${candidate.label} should allow, reject or enqueue.`,
    assertion:
      "Needs a manual review: add the product rule, prune it as invalid, or mark it ignorable.",
  };
}

function mergeQueue(queue: QueueState, item: "text" | "goal" | "compact"): QueueState {
  if (queue === "empty") {
    return item;
  }
  if (queue === item) {
    return queue;
  }
  return "mixed";
}

function drainQueueAfterRun(context: ProductContext): ProductContext {
  if (context.queue === "text") {
    return { ...context, runPhase: "running", queue: "empty" };
  }
  if (context.queue === "goal") {
    return { ...context, runPhase: "completed", queue: "empty", goal: "active" };
  }
  if (context.queue === "compact") {
    return { ...context, runPhase: "compacting", queue: "empty" };
  }
  if (context.queue === "mixed") {
    return { ...context, runPhase: "running", queue: "goal" };
  }
  return {
    ...context,
    runPhase: "completed",
    compactMemory: context.compactMemory === "never" ? "compactable" : context.compactMemory,
  };
}

function buildE2eAssertion(
  context: ProductContext,
  candidate?: Candidate,
  decision?: Decision,
): string {
  if (!candidate || !decision) {
    return "Record the current trace and decide whether it needs further expansion.";
  }
  if (decision.kind === "reject") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then show "${decision.title}" and no forbidden side effect occurs.`;
  }
  if (decision.kind === "enqueue") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then queue state becomes ${decision.next?.queue ?? "unknown"}.`;
  }
  if (decision.kind === "allow") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then transition to ${decision.next ? contextLabel(decision.next) : "next context"}.`;
  }
  if (decision.kind === "system") {
    return `Given ${contextLabel(context)}, when system emits ${candidate.label}, then reconcile to ${decision.next ? contextLabel(decision.next) : "next context"}.`;
  }
  return `Given ${contextLabel(context)}, when ${candidate.label}, product expectation is undefined and must be reviewed.`;
}
