import WebSocket from "ws";

export interface VTSClientOptions {
    /** WebSocket URL of the VTube Studio API. Defaults to ws://localhost:8001 */
    url?: string;
    /** Human-readable plugin name shown to the user in VTS. */
    pluginName: string;
    /** Plugin developer name shown to the user in VTS. */
    pluginDeveloper: string;
    /** Timeout for individual requests in ms. Defaults to 10000. */
    requestTimeoutMs?: number;
}

interface VTSResponse {
    apiName: string;
    apiVersion: string;
    requestID: string;
    messageType: string;
    data: Record<string, unknown>;
}

interface PendingRequest {
    resolve: (value: VTSResponse) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

export class VTSApiError extends Error {
    readonly code: number | undefined;
    constructor(message: string, code?: number) {
        super(message);
        this.name = "VTSApiError";
        this.code = code;
    }
}

export class VTSClient {
    private readonly ws: WebSocket;
    private readonly pendingRequests = new Map<string, PendingRequest>();
    private readonly eventListeners = new Map<string, ((data: Record<string, unknown>) => void)[]>();
    private readonly requestTimeoutMs: number;
    private nextRequestId = 0;
    private authenticated = false;

    private constructor(ws: WebSocket, requestTimeoutMs: number) {
        this.ws = ws;
        this.requestTimeoutMs = requestTimeoutMs;

        this.ws.on("message", (raw: WebSocket.RawData) => {
            this.handleMessage(raw);
        });
    }

    static async connect(opts: VTSClientOptions): Promise<VTSClient> {
        const url = opts.url ?? "ws://localhost:8001";
        const requestTimeoutMs = opts.requestTimeoutMs ?? 10000;

        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            ws.on("open", resolve);
            ws.on("error", (err) => reject(new Error(`Failed to connect to VTS at ${url}: ${err.message}`)));
        });

        const client = new VTSClient(ws, requestTimeoutMs);
        await client.authenticate(opts.pluginName, opts.pluginDeveloper);
        return client;
    }

    async sendRequest(messageType: string, data?: Record<string, unknown>): Promise<VTSResponse> {
        const requestID = String(++this.nextRequestId);
        const request: Record<string, unknown> = {
            apiName: "VTubeStudioPublicAPI",
            apiVersion: "1.0",
            requestID,
            messageType,
        };
        if (data) request["data"] = data;

        const responsePromise = new Promise<VTSResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestID);
                reject(new Error(`VTS request ${messageType} timed out after ${this.requestTimeoutMs}ms`));
            }, this.requestTimeoutMs);
            this.pendingRequests.set(requestID, { resolve, reject, timeout });
        });

        this.ws.send(JSON.stringify(request));
        const response = await responsePromise;

        if (response.messageType === "APIError") {
            const errData = response.data as { message?: string; errorID?: number };
            throw new VTSApiError(
                errData.message ?? "Unknown VTS API error",
                errData.errorID
            );
        }

        return response;
    }

    disconnect(): void {
        for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("VTSClient was disconnected"));
        }
        this.pendingRequests.clear();
        this.eventListeners.clear();
        this.ws.close();
    }

    // --- Plugin authentication ---

    private async authenticate(pluginName: string, pluginDeveloper: string): Promise<void> {
        const tokenResp = await this.sendRequest("AuthenticationTokenRequest", {
            pluginName,
            pluginDeveloper,
        });

        const token = (tokenResp.data as { authenticationToken?: string }).authenticationToken;
        if (!token) {
            throw new Error("VTS did not return an authentication token");
        }

        await new Promise((r) => setTimeout(r, 2000));

        const authResp = await this.sendRequest("AuthenticationRequest", {
            pluginName,
            pluginDeveloper,
            authenticationToken: token,
        });

        const authed = (authResp.data as { authenticated?: boolean }).authenticated;
        if (!authed) {
            throw new Error(
                "VTS authentication failed. Did you approve the plugin in VTube Studio?"
            );
        }
        this.authenticated = true;
    }

    isAuthenticated(): boolean {
        return this.authenticated;
    }

    // --- Event subscriptions ---

    /**
     * Subscribe to a VTS event. The callback fires every time the event
     * occurs until you unsubscribe.
     */
    async subscribeToEvent(
        eventName: string,
        callback: (data: Record<string, unknown>) => void,
        config: Record<string, unknown> = {}
    ): Promise<void> {
        await this.sendRequest("EventSubscriptionRequest", {
            eventName,
            subscribe: true,
            config,
        });

        const listeners = this.eventListeners.get(eventName) ?? [];
        listeners.push(callback);
        this.eventListeners.set(eventName, listeners);
    }

    /**
     * Unsubscribe from a VTS event.
     */
    async unsubscribeFromEvent(eventName: string): Promise<void> {
        await this.sendRequest("EventSubscriptionRequest", {
            eventName,
            subscribe: false,
            config: {},
        });

        this.eventListeners.delete(eventName);
    }

    // --- User click ---

    /**
     * Wait for the user to click on their model in VTS. Returns the exact
     * artmesh and vertex-level position of the click, which can be passed
     * directly to pinItem() with vertexPinType "Provided" for pixel-perfect
     * pinning.
     *
     * Subscribes to ModelClickedEvent, waits for one click, unsubscribes,
     * and returns the topmost artmesh hit info.
     *
     * The caller is responsible for telling the user what to click (e.g.
     * via a UI prompt in the launcher).
     */
    async requestUserClick(): Promise<ClickPinResult> {
        return new Promise<ClickPinResult>((resolve, reject) => {
            const onEvent = (data: Record<string, unknown>): void => {
                const modelWasClicked = data["modelWasClicked"] as boolean | undefined;
                if (!modelWasClicked) return; // click wasn't on the model

                const hits = data["artMeshHits"] as ArtMeshHit[] | undefined;
                if (!hits || hits.length === 0) return;

                // Take the topmost (order 0) hit
                const topHit = hits.find((h) => h.artMeshOrder === 0) ?? hits[0]!;
                const info = topHit.hitInfo;

                // Unsubscribe and resolve
                this.unsubscribeFromEvent("ModelClickedEvent").catch(() => {
                    // Best effort
                });

                resolve({
                    modelID: info.modelID,
                    artMeshID: info.artMeshID,
                    angle: info.angle,
                    size: info.size,
                    vertexID1: info.vertexID1,
                    vertexID2: info.vertexID2,
                    vertexID3: info.vertexID3,
                    vertexWeight1: info.vertexWeight1,
                    vertexWeight2: info.vertexWeight2,
                    vertexWeight3: info.vertexWeight3,
                });
            };

            this.subscribeToEvent("ModelClickedEvent", onEvent, {
                onlyClicksOnModel: true,
            }).catch(reject);
        });
    }

    // --- Item management ---

    async loadItem(opts: LoadItemOptions): Promise<string> {
        const resp = await this.sendRequest("ItemLoadRequest", {
            fileName: opts.fileName,
            positionX: opts.positionX ?? 0,
            positionY: opts.positionY ?? 0,
            size: opts.size ?? 0.5,
            rotation: opts.rotation ?? 0,
            fadeTime: opts.fadeTime ?? 0,
            order: opts.order ?? 1,
            failIfOrderTaken: opts.failIfOrderTaken ?? false,
            smoothing: opts.smoothing ?? 0,
            censored: opts.censored ?? false,
            flipped: opts.flipped ?? false,
            locked: opts.locked ?? false,
            unloadWhenPluginDisconnects: opts.unloadWhenPluginDisconnects ?? true,
            customDataBase64: opts.customDataBase64,
            customDataAskUserFirst: opts.customDataAskUserFirst ?? true,
            customDataSkipAskingUserIfWhitelisted: opts.customDataSkipAskingUserIfWhitelisted ?? true,
            customDataAskTimer: opts.customDataAskTimer ?? -1,
        });

        const instanceID = (resp.data as { instanceID?: string }).instanceID;
        if (!instanceID) {
            throw new Error("VTS ItemLoad did not return an instanceID");
        }
        return instanceID;
    }

    async unloadItem(instanceID: string): Promise<void> {
        await this.sendRequest("ItemUnloadRequest", {
            instanceIDs: [instanceID],
            unloadAllInScene: false,
            unloadAllLoadedByThisPlugin: false,
            allowUnloadingItemsLoadedByUserOrOtherPlugins: false,
        });
    }

    /**
     * Pin an item to a mesh using center-point pinning.
     */
    async pinItem(instanceID: string, pinInfo: PinInfo): Promise<void> {
        await this.sendRequest("ItemPinRequest", {
            pin: true,
            itemInstanceID: instanceID,
            angleRelativeTo: pinInfo.angleRelativeTo ?? "RelativeToModel",
            sizeRelativeTo: pinInfo.sizeRelativeTo ?? "RelativeToWorld",
            vertexPinType: pinInfo.vertexPinType ?? "Center",
            pinInfo: {
                modelID: pinInfo.modelID ?? "",
                artMeshID: pinInfo.artMeshID,
                angle: pinInfo.angle ?? 0,
                size: pinInfo.size ?? 0.5,
            },
        });
    }

    /**
     * Pin an item to an exact position on the model using vertex-level
     * coordinates from requestUserClick() or a saved ClickPinResult.
     */
    async pinItemExact(instanceID: string, pin: ClickPinResult, opts?: {
        angleRelativeTo?: PinInfo["angleRelativeTo"];
        sizeRelativeTo?: PinInfo["sizeRelativeTo"];
        size?: number;
    }): Promise<void> {
        await this.sendRequest("ItemPinRequest", {
            pin: true,
            itemInstanceID: instanceID,
            angleRelativeTo: opts?.angleRelativeTo ?? "RelativeToModel",
            sizeRelativeTo: opts?.sizeRelativeTo ?? "RelativeToWorld",
            vertexPinType: "Provided",
            pinInfo: {
                modelID: pin.modelID,
                artMeshID: pin.artMeshID,
                angle: pin.angle,
                size: opts?.size ?? pin.size,
                vertexID1: pin.vertexID1,
                vertexID2: pin.vertexID2,
                vertexID3: pin.vertexID3,
                vertexWeight1: pin.vertexWeight1,
                vertexWeight2: pin.vertexWeight2,
                vertexWeight3: pin.vertexWeight3,
            },
        });
    }

    async unpinItem(instanceID: string): Promise<void> {
        await this.sendRequest("ItemPinRequest", {
            pin: false,
            itemInstanceID: instanceID,
        });
    }

    // --- Art mesh helpers ---

    async listArtMeshes(): Promise<string[]> {
        const resp = await this.sendRequest("ArtMeshListRequest");
        return (resp.data as { artMeshNames?: string[] }).artMeshNames ?? [];
    }

    async findArtMesh(patterns: string[]): Promise<string | null> {
        const meshNames = await this.listArtMeshes();
        for (const pattern of patterns) {
            const match = meshNames.find((name) => name.toLowerCase().includes(pattern.toLowerCase()));
            if (match) return match;
        }
        return null;
    }

    // --- Parameter injection ---

    async getInputParameters(): Promise<ModelParameter[]> {
        const resp = await this.sendRequest("InputParameterListRequest");
        const data = resp.data as Record<string, unknown>;

        const candidates: unknown[] = [];
        for (const key of ["modelParameters", "defaultParameters", "customParameters"]) {
            const val = data[key];
            if (Array.isArray(val)) candidates.push(...val);
        }
        if (candidates.length === 0) {
            for (const val of Object.values(data)) {
                if (Array.isArray(val)) candidates.push(...val);
            }
        }

        return candidates
            .filter((p): p is ModelParameter =>
                typeof p === "object" &&
                p !== null &&
                typeof (p as { name?: unknown }).name === "string" &&
                typeof (p as { min?: unknown }).min === "number" &&
                typeof (p as { max?: unknown }).max === "number"
            );
    }

    injectParameters(values: ParameterValue[], mode: "set" | "add" = "set"): void {
        const request = {
            apiName: "VTubeStudioPublicAPI",
            apiVersion: "1.0",
            requestID: String(++this.nextRequestId),
            messageType: "InjectParameterDataRequest",
            data: {
                faceFound: true,
                mode,
                parameterValues: values,
            },
        };
        this.ws.send(JSON.stringify(request));
    }

    // --- Internal ---

    private handleMessage(raw: WebSocket.RawData): void {
        let message: VTSResponse;
        try {
            message = JSON.parse(raw.toString()) as VTSResponse;
        } catch {
            return;
        }

        // Check if this is a pending request response
        const pending = this.pendingRequests.get(message.requestID);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(message.requestID);
            pending.resolve(message);
            return;
        }

        // Check if this is a pushed event
        const listeners = this.eventListeners.get(message.messageType);
        if (listeners) {
            for (const listener of listeners) {
                listener(message.data);
            }
        }
    }
}

// --- Public types ---

/**
 * The result of a user clicking on their model. Contains the exact
 * artmesh and vertex-level position of the click. Can be saved to
 * config and reused with pinItemExact().
 */
export interface ClickPinResult {
    modelID: string;
    artMeshID: string;
    angle: number;
    size: number;
    vertexID1: number;
    vertexID2: number;
    vertexID3: number;
    vertexWeight1: number;
    vertexWeight2: number;
    vertexWeight3: number;
}

interface ArtMeshHitInfo {
    modelID: string;
    artMeshID: string;
    angle: number;
    size: number;
    vertexID1: number;
    vertexID2: number;
    vertexID3: number;
    vertexWeight1: number;
    vertexWeight2: number;
    vertexWeight3: number;
}

interface ArtMeshHit {
    artMeshOrder: number;
    isMasked: boolean;
    hitInfo: ArtMeshHitInfo;
}

export interface LoadItemOptions {
    fileName: string;
    customDataBase64: string;
    positionX?: number;
    positionY?: number;
    size?: number;
    rotation?: number;
    fadeTime?: number;
    order?: number;
    failIfOrderTaken?: boolean;
    smoothing?: number;
    censored?: boolean;
    flipped?: boolean;
    locked?: boolean;
    unloadWhenPluginDisconnects?: boolean;
    customDataAskUserFirst?: boolean;
    customDataSkipAskingUserIfWhitelisted?: boolean;
    customDataAskTimer?: number;
}

export interface PinInfo {
    artMeshID: string;
    modelID?: string;
    angle?: number;
    size?: number;
    angleRelativeTo?: "RelativeToModel" | "RelativeToWorld" | "RelativeToPinPosition" | "RelativeToCurrentItemRotation";
    sizeRelativeTo?: "RelativeToModel" | "RelativeToWorld";
    vertexPinType?: "Provided" | "Center" | "Random";
}

export interface ModelParameter {
    name: string;
    min: number;
    max: number;
    value?: number;
    defaultValue?: number;
}

export interface ParameterValue {
    id: string;
    value: number;
    weight?: number;
}
