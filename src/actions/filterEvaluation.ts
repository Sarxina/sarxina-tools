import type { TriggerFilter, TriggerOperator } from "./types.js";

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Maps each operator to the (input, value) types it expects. Lets the
// operatorFns table be type-checked entry-by-entry: an `(input: string)`
// function on a numeric operator key would fail to compile.
type OperatorIO = {
    startsWith:         { input: string;           value: string };
    startsWithWord:     { input: string;           value: string };
    endsWith:           { input: string;           value: string };
    containsString:     { input: string;           value: string };
    containsWord:       { input: string;           value: string };
    equals:             { input: string | number;  value: string | number };
    notEquals:          { input: string | number;  value: string | number };
    lessThan:           { input: number;           value: number };
    greaterThan:        { input: number;           value: number };
    lessThanOrEqual:    { input: number;           value: number };
    greaterThanOrEqual: { input: number;           value: number };
    oneOf:              { input: string | number;  value: (string | number)[] };
    noneOf:             { input: string | number;  value: (string | number)[] };
};

// Single source of truth for operator semantics. The mapped type makes each
// entry's signature depend on its key, so adding a new operator to the union
// without an entry here is a build error AND mistyping an entry is a build
// error.
const operatorFns: { [O in TriggerOperator]: (input: OperatorIO[O]["input"], value: OperatorIO[O]["value"]) => boolean } = {
    startsWith:         (input, v) => input.startsWith(v),
    startsWithWord:     (input, v) => new RegExp(`^${escapeRegex(v)}\\b`).test(input),
    endsWith:           (input, v) => input.endsWith(v),
    containsString:     (input, v) => input.includes(v),
    containsWord:       (input, v) => new RegExp(`\\b${escapeRegex(v)}\\b`).test(input),
    equals:             (input, v) => input === v,
    notEquals:          (input, v) => input !== v,
    lessThan:           (input, v) => input < v,
    greaterThan:        (input, v) => input > v,
    lessThanOrEqual:    (input, v) => input <= v,
    greaterThanOrEqual: (input, v) => input >= v,
    oneOf:              (input, v) => (v as (string | number)[]).includes(input),
    noneOf:             (input, v) => !(v as (string | number)[]).includes(input),
};

type FilterInput = string | number;

/**
 * Evaluate a single TriggerFilter against an input value pulled from a
 * firing's `input[filter.field]`.
 *
 * The dispatch site is unavoidably loose — at runtime we trust that the
 * field's actual type matches what the operator expects. The generic `I`
 * ties the public `input` parameter to the cast's `i` so they're guaranteed
 * to be the same type by construction.
 *
 * @returns `true` if the operator accepts the input/value pair.
 */
export const passesFilter = <I extends FilterInput>(filter: TriggerFilter, input: I): boolean => {
    const fn = operatorFns[filter.op] as (i: I, v: FilterInput | FilterInput[]) => boolean;
    return fn(input, filter.value);
};
