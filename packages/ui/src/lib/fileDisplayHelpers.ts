// Pure utility functions and constants, extracted from fileDisplay.tsx to control file line count

export const DEFAULT_FILE_ICON_NAME = "document";

const ICON_COLOR_MAP: Record<string, { accent: string; background: string }> = {
  audio: { accent: "#7C3AED", background: "#EDE9FE" },
  css: { accent: "#1572B6", background: "#E0F2FE" },
  database: { accent: "#7C3AED", background: "#EDE9FE" },
  document: { accent: "#64748B", background: "#E2E8F0" },
  editorconfig: { accent: "#F59E0B", background: "#FEF3C7" },
  eslint: { accent: "#4F46E5", background: "#E0E7FF" },
  folder: { accent: "#B45309", background: "#FEF3C7" },
  git: { accent: "#F05133", background: "#FEE2E2" },
  go: { accent: "#0EA5E9", background: "#E0F2FE" },
  html: { accent: "#E44D26", background: "#FEE2E2" },
  image: { accent: "#DB2777", background: "#FCE7F3" },
  javascript: { accent: "#CA8A04", background: "#FEF9C3" },
  json: { accent: "#0F766E", background: "#CCFBF1" },
  markdown: { accent: "#2563EB", background: "#DBEAFE" },
  nodejs_alt: { accent: "#16A34A", background: "#DCFCE7" },
  npm: { accent: "#DC2626", background: "#FEE2E2" },
  php: { accent: "#7C3AED", background: "#EDE9FE" },
  prettier: { accent: "#DB2777", background: "#FCE7F3" },
  python: { accent: "#2563EB", background: "#DBEAFE" },
  react: { accent: "#0891B2", background: "#CFFAFE" },
  react_ts: { accent: "#0284C7", background: "#E0F2FE" },
  readme: { accent: "#2563EB", background: "#DBEAFE" },
  rust: { accent: "#9A3412", background: "#FFEDD5" },
  settings: { accent: "#4B5563", background: "#E5E7EB" },
  storybook: { accent: "#EC4899", background: "#FCE7F3" },
  svg: { accent: "#EA580C", background: "#FFEDD5" },
  toml: { accent: "#B45309", background: "#FEF3C7" },
  tsconfig: { accent: "#2563EB", background: "#DBEAFE" },
  typescript: { accent: "#2563EB", background: "#DBEAFE" },
  vitest: { accent: "#65A30D", background: "#ECFCCB" },
  video: { accent: "#DC2626", background: "#FEE2E2" },
  yaml: { accent: "#B91C1C", background: "#FEE2E2" },
  yarn: { accent: "#0F766E", background: "#CCFBF1" },
};

const FILE_NAME_ICON_ALIASES: Record<string, string> = {
  ".editorconfig": "editorconfig",
  ".env": "settings",
  ".gitattributes": "git",
  ".gitignore": "git",
  ".npmrc": "npm",
  ".nvmrc": "nodejs_alt",
  ".prettierrc": "prettier",
  ".yarnrc": "yarn",
  "babel.config": "babel",
  bun: "lock",
  "bun.lock": "lock",
  cargo: "rust",
  "cargo.lock": "lock",
  eslint: "eslint",
  "eslint.config": "eslint",
  gemfile: "gemfile",
  jest: "jest",
  "jest.config": "jest",
  makefile: "makefile",
  "package-lock": "lock",
  "pnpm-lock": "lock",
  readme: "readme",
  tsconfig: "tsconfig",
  vitest: "vitest",
  "vitest.config": "vitest",
  yarn: "yarn",
};

// The icon names and file extensions in material-icons do not always correspond one-to-one.
// For example, the actual material of tsx is called react_ts instead of react_tsx. We focus on alias here to avoid the problem that the extension of the mention panel and input box token does not match the icon.
const EXTENSION_ICON_ALIASES: Record<string, string> = {
  backup: "document",
  bash: "console",
  cjs: "javascript",
  cts: "typescript",
  css: "css",
  // The Office extension is inconsistent with the Material Icons material name. Directly using the extension to spell the path will select the wrong icon;
  // This clearly converges to the same set of product semantics, and the old and new versions of Word files also share word icons.
  doc: "word",
  docx: "word",
  go: "go",
  html: "html",
  java: "java",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  jsx: "react",
  json: "json",
  jsonl: "json",
  mjs: "javascript",
  md: "markdown",
  m4a: "audio",
  m4v: "video",
  flac: "audio",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  ogg: "audio",
  opus: "audio",
  mts: "typescript",
  pdf: "pdf",
  php: "php",
  png: "image",
  pptx: "powerpoint",
  py: "python",
  responses: "json",
  rs: "rust",
  sb: "storybook",
  sql: "database",
  sh: "console",
  snap: "snapcraft",
  svg: "svg",
  toml: "toml",
  ts: "typescript",
  tsx: "react_ts",
  txt: "document",
  wav: "audio",
  weba: "audio",
  webm: "video",
  xlsx: "table",
  yaml: "yaml",
  yml: "yaml",
  zsh: "console",
};

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function trimTrailingSeparator(path: string): string {
  return path.replace(/\/+$/, "");
}

export function resolveIconName(filePath: string): string {
  const normalizedPath = normalizePath(filePath);
  const lastSlash = normalizedPath.lastIndexOf("/");
  const leaf = lastSlash === -1 ? normalizedPath : normalizedPath.slice(lastSlash + 1);
  const normalizedLeaf = leaf.toLowerCase();
  const lastDot = leaf.lastIndexOf(".");
  const fileNameWithoutExtension =
    lastDot === -1 ? normalizedLeaf : normalizedLeaf.slice(0, lastDot);

  const fileNameAliasCandidates = new Set<string>([normalizedLeaf, fileNameWithoutExtension]);

  // Previously, only the results of the complete file name and "remove the last extension" were matched.
  // Multi-segment file names like vitest.config.ts / tsconfig.base.json / .env.local will return the extension icon in advance.
  // Causes configuration file semantics to be lost. Here, stem is rolled back piece by piece, so that common configuration files can stably hit more accurate icons.
  let stemCandidate = fileNameWithoutExtension;
  while (stemCandidate.includes(".")) {
    stemCandidate = stemCandidate.slice(0, stemCandidate.lastIndexOf("."));
    if (stemCandidate) {
      fileNameAliasCandidates.add(stemCandidate);
    }
  }

  for (const candidate of fileNameAliasCandidates) {
    const aliasedFileName = FILE_NAME_ICON_ALIASES[candidate];
    if (aliasedFileName) {
      return aliasedFileName;
    }
  }

  if (lastDot === -1) {
    return DEFAULT_FILE_ICON_NAME;
  }

  const extension = leaf.slice(lastDot + 1).toLowerCase();
  return EXTENSION_ICON_ALIASES[extension] ?? extension ?? DEFAULT_FILE_ICON_NAME;
}

export function getIconPalette(iconName: string) {
  return ICON_COLOR_MAP[iconName] ?? ICON_COLOR_MAP.document!;
}

export function getIconLabel(iconName: string): string {
  if (iconName === "document") {
    return "DOC";
  }

  if (iconName === "folder") {
    return "DIR";
  }

  const compactName = iconName.replace(/[_-]+/g, " ").trim();
  const firstWord = compactName.split(/\s+/)[0] ?? iconName;
  return firstWord.slice(0, 3).toUpperCase();
}

export function buildInlineSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
