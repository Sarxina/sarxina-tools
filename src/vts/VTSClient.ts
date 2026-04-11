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

/**
 * Shape of a VTube Studio API response. Responses always have a requestID
 * that echoes the one from the request, a messageType describing what came
 * back, and an opaque data payload.
 */
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

/**
 * Error thrown when the VTS API returns an APIError messageType.
 */
export class VTSApiError extends Error {
    readonly code: number | undefined;
    constructor(message: string, code?: number) {
        super(message);
        this.name = "VTSApiError";
        this.code = code;
    }
}

/**
 * A connected, authenticated client for the VTube Studio API.
 *
 * Use the static `connect` factory to create an instance — it handles the
 * websocket handshake and plugin authentication in one step.
 */
export class VTSClient {
    private readonly ws: WebSocket;
    private readonly pendingRequests = new Map<string, PendingRequest>();
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

    /**
     * Open a connection to VTube Studio and authenticate as a plugin.
     *
     * Authentication is a two-step handshake: the client first asks VTS for
     * a token, the user approves the plugin in the VTS UI, and then the
     * client uses the token to authenticate for the session. The user only
     * sees the approval prompt the first time a plugin connects.
     */
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

    /**
     * Send a raw request and get the response. Throws VTSApiError if VTS
     * returns an APIError messageType.
     */
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

    /**
     * Close the connection cleanly.
     */
    disconnect(): void {
        // Cancel all pending request timeouts
        for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("VTSClient was disconnected"));
        }
        this.pendingRequests.clear();
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

        // Give the user a moment to approve the plugin in VTS if prompted.
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

    /**
     * Whether the client has completed authentication.
     */
    isAuthenticated(): boolean {
        return this.authenticated;
    }

    // --- Item management ---

    /**
     * Load an item (image, gif, etc.) into the VTS scene from base64-encoded data.
     * Returns the instanceID that can be used to unload or pin the item later.
     */
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

    /**
     * Unload a previously-loaded item by its instanceID.
     */
    async unloadItem(instanceID: string): Promise<void> {
        await this.sendRequest("ItemUnloadRequest", {
            instanceIDs: [instanceID],
            unloadAllInScene: false,
            unloadAllLoadedByThisPlugin: false,
            allowUnloadingItemsLoadedByUserOrOtherPlugins: false,
        });
    }

    /**
     * Pin an item to a specific art mesh on the current model.
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
     * Unpin an item without unloading it.
     */
    async unpinItem(instanceID: string): Promise<void> {
        await this.sendRequest("ItemPinRequest", {
            pin: false,
            itemInstanceID: instanceID,
        });
    }

    // --- Art mesh helpers ---

    /**
     * Get the list of art mesh names on the currently loaded model.
     */
    async listArtMeshes(): Promise<string[]> {
        const resp = await this.sendRequest("ArtMeshListRequest");
        return (resp.data as { artMeshNames?: string[] }).artMeshNames ?? [];
    }

    /**
     * Find the first art mesh whose name contains one of the given patterns.
     * Useful for pinning items to face parts across different models where
     * the exact mesh name isn't known up front.
     *
     * Patterns are tried in order — the first match wins.
     */
    async findArtMesh(patterns: string[]): Promise<string | null> {
        const meshNames = await this.listArtMeshes();
        for (const pattern of patterns) {
            const match = meshNames.find((name) => name.toLowerCase().includes(pattern.toLowerCase()));
            if (match) return match;
        }
        return null;
    }

    // --- Parameter injection ---

    /**
     * Get the list of input parameters on the current model (e.g. FaceAngleX,
     * LeftEyeOpenAmount). Each parameter has a min/max range that describes
     * what values the model accepts.
     */
    async getInputParameters(): Promise<ModelParameter[]> {
        const resp = await this.sendRequest("InputParameterListRequest");
        const data = resp.data as Record<string, unknown>;

        // VTS returns parameters under various keys depending on the kind.
        // Collect anything that looks like a parameter list.
        const candidates: unknown[] = [];
        for (const key of ["modelParameters", "defaultParameters", "customParameters"]) {
            const val = data[key];
            if (Array.isArray(val)) candidates.push(...val);
        }
        // Fall back to collecting any array values if the known keys were empty.
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

    /**
     * Send parameter values to VTS. Mode "set" replaces the value, "add" adds
     * to the current value. The default is "set".
     */
    injectParameters(values: ParameterValue[], mode: "set" | "add" = "set"): void {
        // Fire-and-forget for performance — high-frequency callers (e.g. 30fps
        // animation loops) don't want to await a round-trip per frame.
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
        let response: VTSResponse;
        try {
            response = JSON.parse(raw.toString()) as VTSResponse;
        } catch {
            return; // ignore malformed messages
        }
        const pending = this.pendingRequests.get(response.requestID);
        if (!pending) return; // unknown requestID (e.g. from injectParameters fire-and-forget)

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(response.requestID);
        pending.resolve(response);
    }
}

// --- Public types ---

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
