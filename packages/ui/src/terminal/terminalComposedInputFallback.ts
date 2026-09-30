export interface PendingTerminalInputFallback {
  handled: boolean;
  text: string;
}

export interface TerminalInputFallbackKeydownCandidate {
  kind: "text" | "imeCommit";
  text: string | null;
  eventTimeStamp: number;
  recordedAt: number;
}

export interface TerminalInputFallbackHandledData {
  consumed: boolean;
  data: string;
  keydownEventTimeStamp: number;
  kind: "text" | "imeCommit" | "recentData";
  recordedAt: number;
}

export function createPendingTerminalInputFallback(text: string): PendingTerminalInputFallback {
  return {
    handled: false,
    text,
  };
}

function isPlainTerminalInputData(data: string): boolean {
  // Control inputs such as the arrow keys produce an ESC sequence, such as "\x1b[D".
  // Ordinary characters in these sequences cannot participate in composed input back-up matching, otherwise the real text to be filled may be misjudged as processed.
  return Array.from(data).every((char) => {
    const code = char.codePointAt(0);
    return code !== undefined && code >= 0x20 && code !== 0x7f;
  });
}

function getPlainTerminalInputText(data: string): string | null {
  if (data.includes("\u001b")) {
    return null;
  }

  let text = "";
  for (const char of Array.from(data)) {
    const code = char.codePointAt(0);
    if (code !== undefined && code >= 0x20 && code !== 0x7f) {
      text += char;
    }
  }

  return text.length > 0 ? text : null;
}

function getHandledFallbackData(params: {
  candidate: TerminalInputFallbackKeydownCandidate;
  data: string;
}): string | null {
  if (params.candidate.kind === "imeCommit") {
    // When Sogou and other three-way input methods use Enter to submit candidate words, xterm's onData may convert Chinese and
    // Enter controls are merged into the same chunk (e.g. "Chinese\r"). Determining the entire chunk as non-plain will make
    // The subsequent textarea input writes Chinese again; here only the printable text is extracted from the IME submission key path.
    return getPlainTerminalInputText(params.data);
  }

  if (!isPlainTerminalInputData(params.data) || params.candidate.text !== params.data) {
    return null;
  }

  return params.data;
}

export function createTerminalInputFallbackKeydownCandidate(params: {
  eventTimeStamp: number;
  key: string;
  now: number;
}): TerminalInputFallbackKeydownCandidate | null {
  if (params.key === "Enter" || params.key === "Process") {
    // Third-party Chinese input methods such as Sogou commonly use Enter/Process to submit candidate words on Windows.
    // At this time, xterm may have sent Chinese through onData, and then the textarea input remains with the same combined text;
    // The submission key timestamp is retained here, so that the subsequent plain onData can be deduplicated with the same input to avoid writing again.
    return {
      eventTimeStamp: params.eventTimeStamp,
      kind: "imeCommit",
      recordedAt: params.now,
      text: null,
    };
  }

  if (params.key.length !== 1 || !isPlainTerminalInputData(params.key)) {
    return null;
  }

  return {
    eventTimeStamp: params.eventTimeStamp,
    kind: "text",
    recordedAt: params.now,
    text: params.key,
  };
}

export function markTerminalInputFallbackHandled(
  pending: readonly PendingTerminalInputFallback[],
  data: string,
): void {
  const handledText = isPlainTerminalInputData(data) ? data : getPlainTerminalInputText(data);
  if (!handledText) {
    return;
  }

  let remainingData = handledText;
  for (const item of pending) {
    if (item.handled || item.text.length === 0) {
      continue;
    }
    const index = remainingData.indexOf(item.text);
    if (index === -1) {
      continue;
    }
    item.handled = true;
    remainingData = remainingData.slice(0, index) + remainingData.slice(index + item.text.length);
  }
}

export function recordTerminalInputFallbackHandledData(params: {
  candidate: TerminalInputFallbackKeydownCandidate | null;
  data: string;
  history: readonly TerminalInputFallbackHandledData[];
  maxAgeMs: number;
  now: number;
}): {
  history: TerminalInputFallbackHandledData[];
  usedCandidate: boolean;
} {
  const retainedHistory = params.history.filter(
    (item) => params.now - item.recordedAt <= params.maxAgeMs,
  );
  const candidate = params.candidate;
  if (!candidate || params.now - candidate.recordedAt > params.maxAgeMs) {
    return {
      history: retainedHistory,
      usedCandidate: false,
    };
  }

  const data = getHandledFallbackData({ candidate, data: params.data });
  if (!data) {
    return {
      history: retainedHistory,
      usedCandidate: false,
    };
  }

  return {
    history: [
      ...retainedHistory,
      {
        consumed: false,
        data,
        keydownEventTimeStamp: candidate.eventTimeStamp,
        kind: candidate.kind,
        recordedAt: params.now,
      },
    ],
    usedCandidate: true,
  };
}

export function recordTerminalInputFallbackRecentData(params: {
  data: string;
  history: readonly TerminalInputFallbackHandledData[];
  maxAgeMs: number;
  now: number;
}): TerminalInputFallbackHandledData[] {
  // When Sogou input method submits candidate words, xterm may first write Chinese through onData and then dispatch
  // textarea composed input; this path has no stable keydown candidate and can only use recentData with a very short window to deduplicate.
  const retainedHistory = params.history.filter(
    (item) => params.now - item.recordedAt <= params.maxAgeMs,
  );
  const data = isPlainTerminalInputData(params.data)
    ? params.data
    : getPlainTerminalInputText(params.data);
  if (!data) {
    return retainedHistory;
  }

  return [
    ...retainedHistory,
    {
      consumed: false,
      data,
      keydownEventTimeStamp: params.now,
      kind: "recentData",
      recordedAt: params.now,
    },
  ];
}

export function consumeTerminalInputFallbackHandledData(params: {
  history: readonly TerminalInputFallbackHandledData[];
  inputEventTimeStamp: number;
  maxAgeMs: number;
  maxInputDelayMs: number;
  now: number;
  pending: PendingTerminalInputFallback;
}): void {
  const matched = params.history.find(
    (item) =>
      !item.consumed &&
      params.now - item.recordedAt <= params.maxAgeMs &&
      params.pending.text === item.data &&
      (item.kind === "recentData"
        ? params.now - item.recordedAt <= params.maxInputDelayMs
        : params.inputEventTimeStamp >= item.keydownEventTimeStamp &&
          params.inputEventTimeStamp - item.keydownEventTimeStamp <=
            (item.kind === "imeCommit" ? params.maxAgeMs : params.maxInputDelayMs)),
  );
  if (!matched) {
    return;
  }

  matched.consumed = true;
  params.pending.handled = true;
}

export function resolveTerminalInputFallbackAction(params: {
  pending: PendingTerminalInputFallback;
  textareaValue: string;
}): {
  shouldClearTextarea: boolean;
  shouldWrite: boolean;
} {
  const hasTextareaValue = params.textareaValue.length > 0;
  const shouldWrite = !params.pending.handled && hasTextareaValue;
  return {
    shouldClearTextarea: hasTextareaValue && (params.pending.handled || shouldWrite),
    shouldWrite,
  };
}
