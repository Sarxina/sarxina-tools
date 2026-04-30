import { EventEmitter } from "node:events";
import { ChatClient } from "@twurple/chat";
import { StaticAuthProvider } from "@twurple/auth";
import { EventSubWsListener } from "@twurple/eventsub-ws";
import type { EventSubChannelRedemptionAddEvent } from "@twurple/eventsub-base";
import { ApiClient } from "@twurple/api";
import { type PlatformManager } from "../platforms/PlatformManager.js";

// Add new events (sub, follow, raid, cheer) as a single map entry here, then
// add the same key to TWITCH_EVENT_KINDS below — `satisfies` will catch typos
// but won't catch a missing entry, so the discipline is "edit both lines."
export type TwitchEvents = {
    chat:   { user: string; message: string };
    reward: { user: string; rewardTitle: string; input: string; cost: number };
};

export const TWITCH_EVENT_KINDS = ["chat", "reward"] as const satisfies readonly (keyof TwitchEvents)[];

/**
 * Twitch integration: connects to chat + EventSub and re-emits the events we
 * care about as typed events on this EventEmitter.
 *
 * Reads its connection settings from `process.env`:
 *   - `TWITCH_CLIENT_ID`, `TWITCH_ACCESS_TOKEN` — auth
 *   - `TWITCH_CHANNEL_NAME` — chat channel to join
 *   - `TWITCH_BROADCASTER_ID` — channel to subscribe to redemptions for
 *
 * Subscribers receive normalized payloads (`TwitchEvents`), not the raw
 * twurple types — so swapping the underlying library wouldn't ripple out.
 */
export class TwitchManager extends EventEmitter implements PlatformManager<TwitchEvents> {
    readonly platform = "twitch" as const;
    readonly eventKinds = TWITCH_EVENT_KINDS;

    private chatClient!: ChatClient;
    private apiClient!: ApiClient;
    private eventListener!: EventSubWsListener;

    /**
     * @param options.autoConnect - When `false`, skips wiring up twurple
     *   clients in the constructor. Tests can use this to instantiate a
     *   real `TwitchManager` without dialing Twitch. Defaults to `true`.
     */
    constructor(options: { autoConnect?: boolean } = {}) {
        super();
        if (options.autoConnect !== false) {
            this.setupTwitchConnection();
        }
    }

    /**
     * Wire up twurple's chat + EventSub clients and translate their callbacks
     * into our typed `chat` / `reward` events. Fire-and-forget; failures here
     * surface as `chatClient`/`eventListener` being unusable later.
     */
    private setupTwitchConnection = async (): Promise<void> => {
        const authProvider = new StaticAuthProvider(
            process.env["TWITCH_CLIENT_ID"]!,
            process.env["TWITCH_ACCESS_TOKEN"]!,
        );

        this.chatClient = new ChatClient({
            authProvider,
            channels: [process.env["TWITCH_CHANNEL_NAME"]!],
        });

        this.apiClient = new ApiClient({ authProvider });
        this.eventListener = new EventSubWsListener({ apiClient: this.apiClient });

        this.chatClient.onMessage((_channel, user, message) => {
            this.emit("chat", { user, message });
        });

        // Channel-point redemptions require TWITCH_BROADCASTER_ID to identify
        // the broadcaster's user-id and an access token with the
        // `channel:read:redemptions` scope. Skip the listener if either is
        // missing rather than crashing — chat-only consumers don't need this.
        const broadcasterId = process.env["TWITCH_BROADCASTER_ID"];
        if (broadcasterId) {
            this.eventListener.onChannelRedemptionAdd(
                broadcasterId,
                (event: EventSubChannelRedemptionAddEvent) => {
                    this.emit("reward", {
                        user: event.userDisplayName,
                        rewardTitle: event.rewardTitle,
                        input: event.input,
                        cost: event.rewardCost,
                    });
                },
            );
        } else {
            console.warn(
                "TWITCH_BROADCASTER_ID not set — channel point redemption events disabled.",
            );
        }

        this.eventListener.start();
        this.chatClient.connect();
        console.log("Connected to Twitch Chat");
    };

    /** Send a chat message to the configured channel. */
    say = async (message: string): Promise<void> => {
        await this.chatClient.say(process.env["TWITCH_CHANNEL_NAME"]!, message);
    };

    /** Sugar for `manager.on("chat", handler)`. */
    onChat(handler: (data: TwitchEvents["chat"]) => void) {
        return this.on("chat", handler);
    }

    /** Sugar for `manager.on("reward", handler)`. */
    onReward(handler: (data: TwitchEvents["reward"]) => void) {
        return this.on("reward", handler);
    }
}
