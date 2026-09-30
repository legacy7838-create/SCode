import type { TopicFrameDeliveryKind } from "@zcode/shared/zcode-protocol-v4";

/** A two-phase commit handle for the publisher watermark. */
export interface TopicFrameReservation<F> {
  /** Authoritatively assigned by publisher admission; physical sharding and consumers must not guess it by timing. */
  readonly deliveryKind: TopicFrameDeliveryKind;
  readonly logicalFrameId: string;
  /** Monotonically increasing within the same subscription; used to reject a PersistentProtocol replay of old frames. */
  readonly logicalFrameOrdinal: number;
  readonly frame: F;
  /** The watermark only advances while the current subscription generation is still valid. */
  commit(): boolean;
}
