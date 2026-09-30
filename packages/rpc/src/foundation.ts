/**
 * Layer 0: infrastructure
 * - IDisposable / DisposableStore: resource lifecycle management
 * - Event / Emitter: the event system
 * - CancellationToken: the cancellation token
 *
 * These are the bedrock of the whole IPC framework; every module above depends on them.
 */

// ============================================================================
// Disposable - resource release pattern
// ============================================================================

export interface IDisposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): IDisposable {
  return { dispose: once(fn) };
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (!called) {
      called = true;
      fn();
    }
  };
}

/**
 * DisposableStore collects multiple IDisposable instances and releases them together.
 * Nearly every class in VS Code owns a DisposableStore to manage its sub-resources.
 */
export class DisposableStore implements IDisposable {
  private items = new Set<IDisposable>();
  private isDisposed = false;

  add<T extends IDisposable>(item: T): T {
    if (this.isDisposed) {
      console.warn("Adding to a disposed DisposableStore");
      item.dispose();
      return item;
    }
    this.items.add(item);
    return item;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    for (const item of this.items) {
      item.dispose();
    }
    this.items.clear();
  }
}

// ============================================================================
// Event System - event system
// ============================================================================

/**
 * Event<T> is just a function signature: pass in a listener, get back an IDisposable that unsubscribes.
 * This is the core type through which events flow in the entire IPC framework.
 */
export type Event<T> = (listener: (e: T) => void) => IDisposable;

export namespace Event {
  /** An event that never fires */
  export const None: Event<any> = () => ({ dispose() {} });

  /** Fires at most once, then unsubscribes automatically */
  export function once<T>(event: Event<T>): Event<T> {
    return (listener) => {
      let fired = false;
      const disposable = event((e) => {
        if (!fired) {
          fired = true;
          disposable.dispose();
          listener(e);
        }
      });
      return disposable;
    };
  }

  /** Turns an event into a Promise, unsubscribing automatically once it resolves */
  export function toPromise<T>(event: Event<T>): Promise<T> {
    return new Promise((resolve) => once(event)(resolve));
  }

  /** Filters an event */
  export function filter<T>(event: Event<T>, fn: (e: T) => boolean): Event<T> {
    return (listener) =>
      event((e) => {
        if (fn(e)) {
          listener(e);
        }
      });
  }

  /** Maps an event */
  export function map<T, R>(event: Event<T>, fn: (e: T) => R): Event<R> {
    return (listener) => event((e) => listener(fn(e)));
  }
}

/**
 * Emitter<T> is the emitter behind an event.
 *
 * Key design points:
 * - onWillAddFirstListener: fires when the first subscriber arrives (lazily initializes resources)
 * - onDidRemoveLastListener: fires when the last subscriber leaves (releases resources)
 *
 * This "lazy subscription" mechanism is critical to the IPC framework —
 * ChannelClient's requestEvent relies on it to implement
 * "only send an EventListen request while somebody is listening; send EventDispose when nobody is".
 */
export class Emitter<T> implements IDisposable {
  private listeners = new Set<(e: T) => void>();
  private disposed = false;
  private options?: EmitterOptions;

  constructor(options?: EmitterOptions) {
    this.options = options;
  }

  get event(): Event<T> {
    return (listener: (e: T) => void) => {
      if (this.disposed) {
        return { dispose() {} };
      }

      const isFirst = this.listeners.size === 0;
      this.listeners.add(listener);

      if (isFirst) {
        this.options?.onWillAddFirstListener?.();
      }

      return toDisposable(() => {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) {
          this.options?.onDidRemoveLastListener?.();
        }
      });
    };
  }

  fire(event: T): void {
    if (this.disposed) {
      return;
    }
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

interface EmitterOptions {
  onWillAddFirstListener?: () => void;
  onDidRemoveLastListener?: () => void;
}

/**
 * Relay is an "event relay" whose input source can be swapped dynamically.
 * Used by getDelayedChannel: create the Relay first, then switch the input once the channel promise resolves.
 */
export class Relay<T> implements IDisposable {
  private emitter = new Emitter<T>();
  private inputDisposable: IDisposable = { dispose() {} };

  readonly event = this.emitter.event;

  set input(event: Event<T>) {
    this.inputDisposable.dispose();
    this.inputDisposable = event((e) => this.emitter.fire(e));
  }

  dispose(): void {
    this.inputDisposable.dispose();
    this.emitter.dispose();
  }
}

/**
 * EventMultiplexer merges several event sources into a single event.
 * IPCServer's getMulticastEvent uses it to merge the same-named event of every client.
 */
export class EventMultiplexer<T> implements IDisposable {
  private readonly emitter = new Emitter<T>();
  private readonly disposables: IDisposable[] = [];

  readonly event = this.emitter.event;

  add(event: Event<T>): IDisposable {
    const d = event((e) => this.emitter.fire(e));
    this.disposables.push(d);
    return d;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.emitter.dispose();
  }
}

// ============================================================================
// CancellationToken - cancellation token
// ============================================================================

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<void>;
}

export namespace CancellationToken {
  export const None: CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: Event.None,
  };
}

export class CancellationTokenSource implements IDisposable {
  private _token?: CancellationToken;
  private emitter = new Emitter<void>();
  private _isCancelled = false;

  get token(): CancellationToken {
    if (!this._token) {
      this._token = {
        isCancellationRequested: false,
        onCancellationRequested: this.emitter.event,
      };
    }
    return this._token;
  }

  cancel(): void {
    if (!this._isCancelled) {
      this._isCancelled = true;
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
