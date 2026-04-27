import type { EventEmitter } from "node:events";
import type { TriggerSourcePlatform } from "../actions/types.js";

/**
 * Contract every platform integration must satisfy.
 *
 * Extends `EventEmitter` so implementers expose typed `on`/`off`/`once`/`emit`
 * matching their own event map. The action registry can then subscribe
 * generically without each manager needing its own translation method.
 *
 * @typeParam TEvents - the platform's event map: `{ eventName: payloadShape }`.
 *   Determines the keys allowed in `eventKinds` and the listener payloads.
 */
export interface PlatformManager<TEvents = Record<string, unknown>> extends EventEmitter {
    readonly platform: TriggerSourcePlatform;
    readonly eventKinds: readonly (keyof TEvents & string)[];

    on<K extends keyof TEvents & string>(event: K, listener: (data: TEvents[K]) => void): this;
    off<K extends keyof TEvents & string>(event: K, listener: (data: TEvents[K]) => void): this;
    once<K extends keyof TEvents & string>(event: K, listener: (data: TEvents[K]) => void): this;
    emit<K extends keyof TEvents & string>(event: K, data: TEvents[K]): boolean;

}
