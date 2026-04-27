import type { ActionHandler, Trigger, TriggerFiring } from "./types.js";

/**
 * An Action bundles a set of handlers (what to do) with the triggers that
 * invoke them (when to do it). The Action itself doesn't know how triggers
 * are matched against incoming events — that's the registry's job.
 */
export class Action {
    constructor(
        public readonly name: string,
        public readonly triggers: Trigger[],
        public readonly handlers: ActionHandler[],
    ) {}

    /**
     * Run every handler against this firing, in order. Awaits async handlers
     * sequentially so errors surface and side effects don't race each other.
     */
    async fire(firing: TriggerFiring): Promise<void> {
        for (const handler of this.handlers) {
            await handler(firing);
        }
    }
}
