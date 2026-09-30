// discovery barrel once exposed monotonicity and mutation API together.
// Forming a second exposure path: the consumer may bypass the independent subpath, and the Desktop build has also been re-exported due to bad
// Unable to start. Single origin requires "exactly one exposure path for one API": this file only exports what is needed for discovery
// config/digest; mutation and monotonicity must be consumed directly from their respective package subpaths.
export * from "./workspace-hook-config.js";
export * from "./workspace-hook-digest.js";
