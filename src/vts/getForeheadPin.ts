import type { VTSClient, ClickPinResult } from "./VTSClient.js";

/**
 * Storage interface for persisting forehead pin data. The caller provides
 * the implementation — could be a JSON file, Electron config store, etc.
 */
export interface PinStorage {
    /** Load a previously saved forehead pin, or null if none exists. */
    load(): ClickPinResult | null;
    /** Save a forehead pin for future use. */
    save(pin: ClickPinResult): void;
}

/**
 * Get the user's forehead pin coordinates. If a pin was previously saved
 * in the provided storage, returns it immediately. Otherwise, waits for
 * the user to click their forehead in VTS and saves the result.
 *
 * The caller is responsible for prompting the user (via UI, console, etc.)
 * BEFORE calling this function, since it blocks waiting for a click.
 *
 * @param vts - Connected VTSClient instance
 * @param storage - Where to load/save the pin coordinates
 * @param forceNew - If true, ignores saved pin and asks the user again
 * @returns The forehead pin coordinates, ready for pinItemExact()
 */
export async function getForeheadPin(
    vts: VTSClient,
    storage: PinStorage,
    forceNew: boolean = false
): Promise<ClickPinResult> {
    if (!forceNew) {
        const saved = storage.load();
        if (saved) return saved;
    }

    const pin = await vts.requestUserClick();
    storage.save(pin);
    return pin;
}
