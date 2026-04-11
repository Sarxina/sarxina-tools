import { ChatClient } from "@twurple/chat";
import { StaticAuthProvider } from "@twurple/auth";

import { EventSubWsListener } from "@twurple/eventsub-ws";
import type { EventSubChannelRedemptionAddEvent } from "@twurple/eventsub-base";
import { ApiClient } from "@twurple/api";

// Manager class that listens for both chat messages and channel point redeems,
// firing registered callbacks on a hit.
//
// Usage:
//   const chat = new TwitchChatManager();
//   chat.registerNewChatCallback((msg, user) => { ... });
//   chat.registerNewRedeemCallback((user, input, cost) => { ... });
export class TwitchChatManager {
    private chatClient!: ChatClient;
    private apiClient!: ApiClient;
    private eventListener!: EventSubWsListener;
    private chatCallbacks: ((message: string, chatter: string) => void)[] = [];
    private redeemCallbacks: ((chatter: string, input: string, cost: number) => void)[] = [];

    constructor() {
        this.setupTwitchConnection();
    }

    registerNewChatCallback = (callback: (message: string, chatter: string) => void): void => {
        this.chatCallbacks.push(callback);
    };

    registerNewRedeemCallback = (
        callback: (chatter: string, input: string, cost: number) => void
    ): void => {
        this.redeemCallbacks.push(callback);
    };

    private setupTwitchConnection = async (): Promise<void> => {
        const authProvider = new StaticAuthProvider(
            process.env["TWITCH_CLIENT_ID"]!,
            process.env["TWITCH_ACCESS_TOKEN"]!
        );

        this.chatClient = new ChatClient({
            authProvider,
            channels: [process.env["TWITCH_CHANNEL_NAME"]!],
        });

        this.apiClient = new ApiClient({ authProvider });
        this.eventListener = new EventSubWsListener({ apiClient: this.apiClient });

        // Fire all registered chat callbacks on every message
        this.chatClient.onMessage((_channel, user, message) => {
            this.chatCallbacks.forEach((cb) => cb(message, user));
        });

        // Fire all registered redeem callbacks on every channel point redemption
        this.eventListener.onChannelRedemptionAdd(
            process.env["TWITCH_BROADCASTER_ID"]!,
            (event: EventSubChannelRedemptionAddEvent) => {
                this.redeemCallbacks.forEach((cb) =>
                    cb(event.userDisplayName, event.input, event.rewardCost)
                );
            }
        );

        this.eventListener.start();
        this.chatClient.connect();
        console.log("Connected to Twitch Chat");
    };

    say = async (message: string): Promise<void> => {
        await this.chatClient.say(process.env["TWITCH_CHANNEL_NAME"]!, message);
    };
}

// Class that handles a single command
export class ChatCommandManager {
    private chatManager: TwitchChatManager
    private command: string

    constructor(
        command: string,
        msgCallback: (subcommand: string, chatter: string) => void,
        chatManager: TwitchChatManager
    ) {
        this.command = command;
        this.chatManager = chatManager;

        // Create funciton that strips the command sends the subcommand
        const subcommandCallback = (message: string, chatter: string) => {
            const frontString = message.split(' ')[0];
            const subcommand = message.includes(" ") ? message.slice(message.indexOf(" ") + 1) : "";

            if (frontString === this.command) {
                msgCallback(subcommand, chatter);
            }
        }
        this.chatManager.registerNewChatCallback(subcommandCallback);
    }
}
