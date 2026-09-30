// Interaction adjustment: The table itself can be fully browsed in the message flow, and retaining the fullscreen entry will interrupt the reading path.
// Here, table magnification is turned off uniformly, and only light operations such as copy/export are retained. The message body and inference panel share the same configuration.
export const STREAMDOWN_CONTROLS = {
  table: {
    fullscreen: false,
  },
} as const;
