/**
 * The allowlist every filesystem call is confined to.
 *
 * Spec: docs/specs/rust-native-fs.md §3.2-§3.3. The enforcement itself lives in
 * the native crate (`zcode-fs`): every path-taking export requires a `roots`
 * array, canonicalizes the requested path, and rejects anything that escapes.
 * This class only decides *which* roots are legitimate — it is the policy input
 * to a mechanism that cannot be switched off.
 *
 * The set is append-only by construction: there is no `remove`, no `clear`, no
 * `replace`, and no flag to skip the check. That matters because
 * `checkFilesExist` memoizes verdicts for 60 s, and a verdict produced under one
 * root set stays valid only if the set never shrinks.
 */
export class FileServiceScope {
    readonly #roots = new Set<string>();

    constructor(seed: Iterable<string> = []) {
        for (const path of seed) {
            this.allow(path);
        }
    }

    /**
     * Admits a root. Deduplicated by the exact string; the native side
     * canonicalizes it per call, so a root that does not exist yet (a scratch
     * workspace about to be created) is harmless and simply contributes nothing
     * until it does.
     */
    allow(...paths: readonly string[]): void {
        for (const path of paths) {
            const trimmed = path.trim();
            if (trimmed) {
                this.#roots.add(trimmed);
            }
        }
    }

    /** A snapshot for one native call. Never hand out the live set. */
    roots(): string[] {
        return [...this.#roots];
    }

    get size(): number {
        return this.#roots.size;
    }
}
