// The platform an event originates from. YouTube is reserved for future work —
// the rest of the file only models Twitch today.
export type TriggerSourcePlatform = "twitch" | "youtube";

// Which kind of source event this trigger subscribes to.
export type TriggerSourceKind = "chat" | "reward";

// The source a trigger listens to: a platform + the kind of event on that
// platform. Same kind can legitimately appear on multiple platforms.
export type TriggerSource = {
    platform: TriggerSourcePlatform;
    kind: TriggerSourceKind;
};

// Filter operators, grouped by the value type they operate on. Splitting them
// keeps the eventual TriggerFilter shape unambiguous — each (operator, value)
// pair has a single, type-checkable value type.

export type TriggerStringOperator =
    | "startsWith"
    | "endsWith"
    | "containsWord"     // matches the value as a whole word, not a substring
    | "containsString"   // raw substring match
    | "equals"
    | "notEquals";

export type TriggerNumberOperator =
    | "equals"
    | "notEquals"
    | "lessThan"
    | "greaterThan"
    | "lessThanOrEqual"
    | "greaterThanOrEqual";

// List operators: the field's value must match one of (or none of) the items
// in the supplied list.
export type TriggerStringListOperator = "oneOf" | "noneOf";
export type TriggerNumberListOperator = "oneOf" | "noneOf";

// Convenience union covering every operator across every value-type group.
export type TriggerOperator =
    | TriggerStringOperator
    | TriggerNumberOperator
    | TriggerStringListOperator
    | TriggerNumberListOperator;

// Trigger inputs: the minimum information a trigger carries into its handler.
// Real events from Twitch/YouTube expose far more; these are the fields we
// actually care about at the Action layer.

export type TwitchChatTriggerInput = {
    user: string;
    message: string;
};

export type TwitchRewardTriggerInput = {
    user: string;
    rewardTitle: string;
    input: string;
    cost: number;
};

// Union of every possible runtime payload a trigger can carry. New trigger
// kinds extend this as they're added.
export type TriggerInput =
    | TwitchChatTriggerInput
    | TwitchRewardTriggerInput;

// A runtime firing of a trigger: the source it came from plus the input it
// carried. This is what an Action's handler receives.
export type TriggerFiring = {
    source: TriggerSource;
    input: TriggerInput;
};

// A filter binds an input field to a comparison: which field of the firing's
// input to look at, the operator to apply, and the value to compare against.

export type TriggerStringFilter = {
    field: string;
    op: TriggerStringOperator;
    value: string;
};

export type TriggerNumberFilter = {
    field: string;
    op: TriggerNumberOperator;
    value: number;
};

export type TriggerStringListFilter = {
    field: string;
    op: TriggerStringListOperator;
    value: string[];
};

export type TriggerNumberListFilter = {
    field: string;
    op: TriggerNumberListOperator;
    value: number[];
};

// Anything that can sit in a Trigger's `filters` array.
export type TriggerFilter =
    | TriggerStringFilter
    | TriggerNumberFilter
    | TriggerStringListFilter
    | TriggerNumberListFilter;

// A subscription config: which source to listen to, and any predicates the
// firing must satisfy. An empty filters array means "fire on every event from
// this source".
export type Trigger = {
    source: TriggerSource;
    filters: TriggerFilter[];
};

// The user-supplied function an Action runs when one of its triggers fires
// and all of its filters pass. The firing carries source + input so the
// handler can branch on what produced it if needed.
export type ActionHandler = (firing: TriggerFiring) => void | Promise<void>;
