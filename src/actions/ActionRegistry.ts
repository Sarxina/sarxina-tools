import { Action } from "./Action.js";
import { passesFilter } from "./filterEvaluation.js";
import type { PlatformManager } from "../platforms/PlatformManager.js";
import type { Trigger, TriggerFiring, TriggerInput, TriggerSource, TriggerSourceKind } from "./types.js";

/**
 * Sits between platform managers and Actions. For every (manager, event kind)
 * pair the registry subscribes to the manager's typed event stream, normalizes
 * each event into a `TriggerFiring`, and invokes every registered Action whose
 * triggers match (source identity + every filter passes).
 */
export class ActionRegistry {
    private actions: Action[] = [];

    constructor(managers: PlatformManager[]) {
        for (const m of managers) {
            for (const kind of m.eventKinds) {
                m.on(kind, (input: unknown) => this.dispatch({
                    source: { platform: m.platform, kind: kind as TriggerSourceKind },
                    input: input as TriggerInput,
                }));
            }
        }
    }

    /** Add an Action. Existing actions stay registered. */
    register(action: Action): void {
        this.actions.push(action);
    }

    /** Remove every registered Action with the given name (no-op if none match). */
    unregister(name: string): void {
        this.actions = this.actions.filter(a => a.name !== name);
    }

    /**
     * For each Action, fire it (without awaiting) if any of its triggers
     * matches the firing. Actions run independently — one slow handler does
     * not block other Actions from running.
     */
    private dispatch(firing: TriggerFiring): void {
        for (const action of this.actions) {
            const hit = action.triggers.some(t => this.triggerMatches(t, firing));
            if (hit) void action.fire(firing);
        }
    }

    /**
     * A trigger matches a firing when its source matches AND every filter
     * passes. Filters are AND-combined; an empty filters array matches every
     * firing from the right source.
     *
     * Field-binding lookup happens here: each filter pulls its target value
     * out of `firing.input[filter.field]`. If the field is missing or has the
     * wrong shape, the filter fails closed (returns `false`) silently.
     */
    private triggerMatches(trigger: Trigger, firing: TriggerFiring): boolean {
        if (!sameSource(trigger.source, firing.source)) return false;
        return trigger.filters.every(f => {
            const fieldValue = (firing.input as Record<string, unknown>)[f.field];
            if (typeof fieldValue !== "string" && typeof fieldValue !== "number") return false;
            return passesFilter(f, fieldValue);
        });
    }
}

const sameSource = (a: TriggerSource, b: TriggerSource): boolean =>
    a.platform === b.platform && a.kind === b.kind;
