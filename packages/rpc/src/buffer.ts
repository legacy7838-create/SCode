/**
 * Layer 0.5: cross-platform Buffer abstraction
 *
 * VS Code needs one set of binary operations across Node.js (Buffer) and the browser (Uint8Array).
 * VSBuffer is a thin wrapper over Uint8Array that provides a uniform read/write interface.
 *
 * This is the foundation for the serialization and transport layers.
 */
import { rpcBytesPort } from "./bytes-port.js";

export class VSBuffer {
  readonly buffer: Uint8Array;
  readonly byteLength: number;

  private constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    this.byteLength = buffer.byteLength;
  }

  /** Allocates an empty buffer of the given size */
  static alloc(byteLength: number): VSBuffer {
    return new VSBuffer(rpcBytesPort().alloc(byteLength));
  }

  /** Wraps an existing Uint8Array */
  static wrap(buffer: Uint8Array): VSBuffer {
    return new VSBuffer(buffer);
  }

  /** Creates a buffer from a string (UTF-8) */
  static fromString(str: string): VSBuffer {
    return new VSBuffer(rpcBytesPort().stringToBytes(str));
  }

  /** Concatenates multiple buffers */
  static concat(buffers: VSBuffer[], totalLength?: number): VSBuffer {
    const len = totalLength ?? buffers.reduce((sum, b) => sum + b.byteLength, 0);
    return new VSBuffer(
      rpcBytesPort().concat(
        buffers.map((b) => b.buffer),
        len,
      ),
    );
  }

  /** Converts to a UTF-8 string */
  toString(): string {
    return rpcBytesPort().bytesToString(this.buffer) ?? new TextDecoder().decode(this.buffer);
  }

  /** Returns a slice */
  slice(start: number, end?: number): VSBuffer {
    return new VSBuffer(rpcBytesPort().slice(this.buffer, start, end));
  }

  /** Copies data into this buffer at the given position */
  set(source: VSBuffer | Uint8Array, offset = 0): void {
    const raw = source instanceof VSBuffer ? source.buffer : source;
    this.buffer.set(raw, offset);
  }

  readUInt8(offset: number): number {
    return this.buffer[offset];
  }

  writeUInt8(value: number, offset: number): void {
    this.buffer[offset] = value;
  }

  readUInt32BE(offset: number): number {
    return rpcBytesPort().readUInt32BE(this.buffer, offset);
  }

  writeUInt32BE(value: number, offset: number): void {
    rpcBytesPort().writeUInt32BE(this.buffer, value, offset);
  }
}
