// One-time rename list: The selector must exactly match the original Built-in rules, and no guessing based on the model name is allowed.
export const legacyReasoningLevelRenames = [
  {
    modelMatch: ".*glm-5(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*GLM-5\\.2(?:[.\\-:/\\[].*)?",
    oldLevel: "nothink",
  },
  {
    modelMatch: ".*GLM-5-Turbo(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-5\\.1(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-5\\.1-highspeed(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-5v-turbo(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.7(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.7-flashx(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.7-flash(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.6(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.5(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.5-air(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*kimi-k2\\.7-code(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*kimi-k2\\.6(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*kimi-k2\\.5(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*deepseek-v4-flash(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*deepseek-v4-pro(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen3\\.5-plus(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen3\\.5-flash(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen-plus(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen-flash(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen3-vl-plus(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*mimo-v2\\.5(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*mimo-v2\\.5-pro(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
  {
    modelMatch: ".*mimo-v2-flash(?:[.\\-:/\\[].*)?",
    oldLevel: "off",
  },
] as const;
