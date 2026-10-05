export type ClientOptions = {
    baseUrl: `${string}://${string}` | (string & {});
};
export type Uuid = string;
export type UuidInput = string;
/**
 * File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.
 */
export type FileName = string;
/**
 * File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.
 */
export type FileNameInput = string;
export type MessageSubmission = ({
    text: string;
} | {
    assetIDs: Array<unknown>;
}) & {
    messageID: string;
    text: string;
    /**
     * Unique after lowercase UUID canonicalization; case-insensitive equality is additionally enforced at runtime.
     */
    assetIDs: Array<string>;
};
export type MessageSubmissionInput = ({
    text: string;
} | {
    assetIDs: Array<unknown>;
}) & {
    messageID: string;
    text: string;
    /**
     * Unique after lowercase UUID canonicalization; case-insensitive equality is additionally enforced at runtime.
     */
    assetIDs?: Array<string>;
};
export type ThreadCreation = {
    threadID: string;
    /**
     * Trimmed before validation: 1–160 UTF-16 code units after removing surrounding whitespace. Foreign validators may count Unicode code points instead.
     */
    title: string;
};
export type ThreadCreationInput = {
    threadID: string;
    /**
     * Trimmed before validation: 1–160 UTF-16 code units after removing surrounding whitespace. Foreign validators may count Unicode code points instead.
     */
    title: string;
};
export type ThreadUpdate = {
    /**
     * Trimmed before validation: 1–160 UTF-16 code units after removing surrounding whitespace. Foreign validators may count Unicode code points instead.
     */
    title: string;
};
export type ThreadUpdateInput = {
    /**
     * Trimmed before validation: 1–160 UTF-16 code units after removing surrounding whitespace. Foreign validators may count Unicode code points instead.
     */
    title: string;
};
export type RunCancellation = {
    commandID: string;
};
export type RunCancellationInput = {
    commandID: string;
};
export type PublicThread = {
    threadID: string;
    /**
     * Trimmed before validation: 1–160 UTF-16 code units after removing surrounding whitespace. Foreign validators may count Unicode code points instead.
     */
    title: string;
    createdAt: string;
    archivedAt: string | null;
};
export type PublicThreadInput = {
    threadID: string;
    /**
     * Trimmed before validation: 1–160 UTF-16 code units after removing surrounding whitespace. Foreign validators may count Unicode code points instead.
     */
    title: string;
    createdAt: string;
    archivedAt: string | null;
};
export type PublicAsset = {
    assetID: string;
    source: 'upload' | 'generated';
    /**
     * File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.
     */
    name: string;
    mimeType: string;
    byteLength: number;
    createdAt: string;
    messageID?: string;
    runID?: string;
};
export type PublicAssetInput = {
    assetID: string;
    source: 'upload' | 'generated';
    /**
     * File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.
     */
    name: string;
    mimeType: string;
    byteLength: number;
    createdAt: string;
    messageID?: string;
    runID?: string;
};
export type PublicMessage = {
    messageID: string;
    role: 'user' | 'assistant';
    assets?: Array<{
        assetID: string;
        source: 'upload' | 'generated';
        /**
         * File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.
         */
        name: string;
        mimeType: string;
        byteLength: number;
        createdAt: string;
        messageID?: string;
        runID?: string;
    }>;
    text: string;
    createdAt: string;
};
export type PublicMessageInput = {
    messageID: string;
    role: 'user' | 'assistant';
    assets?: Array<{
        assetID: string;
        source: 'upload' | 'generated';
        /**
         * File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.
         */
        name: string;
        mimeType: string;
        byteLength: number;
        createdAt: string;
        messageID?: string;
        runID?: string;
    }>;
    text: string;
    createdAt: string;
};
export type ActiveRun = {
    runID: string;
    messageID: string;
    status: 'accepted' | 'running' | 'stopping';
};
export type ActiveRunInput = {
    runID: string;
    messageID: string;
    status: 'accepted' | 'running' | 'stopping';
};
export type FailedRun = {
    runID: string;
    messageID: string;
    reason: 'execution-error' | 'interrupted' | 'sandbox-recovery-required';
};
export type FailedRunInput = {
    runID: string;
    messageID: string;
    reason: 'execution-error' | 'interrupted' | 'sandbox-recovery-required';
};
export type SessionResponse = {
    user: {
        userID: string;
        name: string;
        email: string;
        image: string | null;
    } | null;
};
export type SessionResponseInput = {
    user: {
        userID: string;
        name: string;
        email: string;
        image: string | null;
    } | null;
};
export type ThreadsResponse = {
    threads: Array<{
        threadID: string;
        /**
         * Trimmed before validation: 1–160 UTF-16 code units after removing surrounding whitespace. Foreign validators may count Unicode code points instead.
         */
        title: string;
        createdAt: string;
        archivedAt: string | null;
    }>;
};
export type ThreadsResponseInput = {
    threads: Array<{
        threadID: string;
        /**
         * Trimmed before validation: 1–160 UTF-16 code units after removing surrounding whitespace. Foreign validators may count Unicode code points instead.
         */
        title: string;
        createdAt: string;
        archivedAt: string | null;
    }>;
};
export type ThreadResponse = {
    thread: {
        threadID: string;
        /**
         * Trimmed before validation: 1–160 UTF-16 code units after removing surrounding whitespace. Foreign validators may count Unicode code points instead.
         */
        title: string;
        createdAt: string;
        archivedAt: string | null;
    };
};
export type ThreadResponseInput = {
    thread: {
        threadID: string;
        /**
         * Trimmed before validation: 1–160 UTF-16 code units after removing surrounding whitespace. Foreign validators may count Unicode code points instead.
         */
        title: string;
        createdAt: string;
        archivedAt: string | null;
    };
};
export type MessagesResponse = {
    messages: Array<{
        messageID: string;
        role: 'user' | 'assistant';
        assets?: Array<{
            assetID: string;
            source: 'upload' | 'generated';
            /**
             * File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.
             */
            name: string;
            mimeType: string;
            byteLength: number;
            createdAt: string;
            messageID?: string;
            runID?: string;
        }>;
        text: string;
        createdAt: string;
    }>;
    activeRuns: Array<{
        runID: string;
        messageID: string;
        status: 'accepted' | 'running' | 'stopping';
    }>;
    failedRuns: Array<{
        runID: string;
        messageID: string;
        reason: 'execution-error' | 'interrupted' | 'sandbox-recovery-required';
    }>;
};
export type MessagesResponseInput = {
    messages: Array<{
        messageID: string;
        role: 'user' | 'assistant';
        assets?: Array<{
            assetID: string;
            source: 'upload' | 'generated';
            /**
             * File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.
             */
            name: string;
            mimeType: string;
            byteLength: number;
            createdAt: string;
            messageID?: string;
            runID?: string;
        }>;
        text: string;
        createdAt: string;
    }>;
    activeRuns: Array<{
        runID: string;
        messageID: string;
        status: 'accepted' | 'running' | 'stopping';
    }>;
    failedRuns: Array<{
        runID: string;
        messageID: string;
        reason: 'execution-error' | 'interrupted' | 'sandbox-recovery-required';
    }>;
};
export type MessageAccepted = {
    messageID: string;
    commandID: string;
    runID: string;
};
export type MessageAcceptedInput = {
    messageID: string;
    commandID: string;
    runID: string;
};
export type CancellationAccepted = {
    commandID: string;
    runID: string;
};
export type CancellationAcceptedInput = {
    commandID: string;
    runID: string;
};
export type AssetResponse = {
    asset: {
        assetID: string;
        source: 'upload' | 'generated';
        /**
         * File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.
         */
        name: string;
        mimeType: string;
        byteLength: number;
        createdAt: string;
        messageID?: string;
        runID?: string;
    };
};
export type AssetResponseInput = {
    asset: {
        assetID: string;
        source: 'upload' | 'generated';
        /**
         * File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.
         */
        name: string;
        mimeType: string;
        byteLength: number;
        createdAt: string;
        messageID?: string;
        runID?: string;
    };
};
export type AssetsResponse = {
    assets: Array<{
        assetID: string;
        source: 'upload' | 'generated';
        /**
         * File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.
         */
        name: string;
        mimeType: string;
        byteLength: number;
        createdAt: string;
        messageID?: string;
        runID?: string;
    }>;
};
export type AssetsResponseInput = {
    assets: Array<{
        assetID: string;
        source: 'upload' | 'generated';
        /**
         * File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.
         */
        name: string;
        mimeType: string;
        byteLength: number;
        createdAt: string;
        messageID?: string;
        runID?: string;
    }>;
};
export type EmptyRequest = {
    [key: string]: never;
};
export type EmptyRequestInput = {
    [key: string]: never;
};
export type ErrorResponse = {
    error: string;
};
export type ErrorResponseInput = {
    error: string;
};
export type LogoutData = {
    body: EmptyRequestInput;
    path?: never;
    query?: never;
    url: '/api/logout';
};
export type LogoutErrors = {
    /**
     * Untrusted origin
     */
    403: unknown;
    /**
     * Expected JSON
     */
    415: unknown;
};
export type LogoutResponses = {
    /**
     * Session durably revoked and SDK cookies expired
     */
    200: unknown;
};
export type GetSessionData = {
    body?: never;
    path?: never;
    query?: never;
    url: '/api/session';
};
export type GetSessionResponses = {
    /**
     * Current identity
     */
    200: SessionResponse;
};
export type GetSessionResponse = GetSessionResponses[keyof GetSessionResponses];
export type ListThreadsData = {
    body?: never;
    path?: never;
    query?: never;
    url: '/api/threads';
};
export type ListThreadsErrors = {
    /**
     * Invalid input
     */
    400: unknown;
    /**
     * Authentication required
     */
    401: unknown;
    /**
     * Untrusted origin
     */
    403: unknown;
    /**
     * Not found (including foreign identifiers)
     */
    404: unknown;
    /**
     * Conflicting intent or archived thread
     */
    409: unknown;
    /**
     * Expected JSON request
     */
    415: unknown;
    /**
     * Unavailable; retry after recovery
     */
    503: unknown;
};
export type ListThreadsResponses = {
    /**
     * Owned threads
     */
    200: ThreadsResponse;
};
export type ListThreadsResponse = ListThreadsResponses[keyof ListThreadsResponses];
export type CreateThreadData = {
    body: ThreadCreationInput;
    path?: never;
    query?: never;
    url: '/api/threads';
};
export type CreateThreadErrors = {
    /**
     * Invalid input
     */
    400: unknown;
    /**
     * Authentication required
     */
    401: unknown;
    /**
     * Untrusted origin
     */
    403: unknown;
    /**
     * Not found (including foreign identifiers)
     */
    404: unknown;
    /**
     * Conflicting intent or archived thread
     */
    409: unknown;
    /**
     * Expected JSON request
     */
    415: unknown;
    /**
     * Unavailable; retry after recovery
     */
    503: unknown;
};
export type CreateThreadResponses = {
    /**
     * Exact replay
     */
    200: ThreadResponse;
    /**
     * Created
     */
    201: ThreadResponse;
};
export type CreateThreadResponse = CreateThreadResponses[keyof CreateThreadResponses];
export type GetThreadData = {
    body?: never;
    path: {
        threadID: UuidInput;
    };
    query?: never;
    url: '/api/threads/{threadID}';
};
export type GetThreadErrors = {
    /**
     * Invalid input
     */
    400: unknown;
    /**
     * Authentication required
     */
    401: unknown;
    /**
     * Untrusted origin
     */
    403: unknown;
    /**
     * Not found (including foreign identifiers)
     */
    404: unknown;
    /**
     * Conflicting intent or archived thread
     */
    409: unknown;
    /**
     * Expected JSON request
     */
    415: unknown;
    /**
     * Unavailable; retry after recovery
     */
    503: unknown;
};
export type GetThreadResponses = {
    /**
     * Owned thread
     */
    200: ThreadResponse;
};
export type GetThreadResponse = GetThreadResponses[keyof GetThreadResponses];
export type UpdateThreadData = {
    body: ThreadUpdateInput;
    path: {
        threadID: UuidInput;
    };
    query?: never;
    url: '/api/threads/{threadID}';
};
export type UpdateThreadErrors = {
    /**
     * Invalid input
     */
    400: unknown;
    /**
     * Authentication required
     */
    401: unknown;
    /**
     * Untrusted origin
     */
    403: unknown;
    /**
     * Not found (including foreign identifiers)
     */
    404: unknown;
    /**
     * Conflicting intent or archived thread
     */
    409: unknown;
    /**
     * Expected JSON request
     */
    415: unknown;
    /**
     * Unavailable; retry after recovery
     */
    503: unknown;
};
export type UpdateThreadResponses = {
    /**
     * Updated
     */
    200: ThreadResponse;
};
export type UpdateThreadResponse = UpdateThreadResponses[keyof UpdateThreadResponses];
export type ArchiveThreadData = {
    body: EmptyRequestInput;
    path: {
        threadID: UuidInput;
    };
    query?: never;
    url: '/api/threads/{threadID}/archive';
};
export type ArchiveThreadErrors = {
    /**
     * Invalid input
     */
    400: unknown;
    /**
     * Authentication required
     */
    401: unknown;
    /**
     * Untrusted origin
     */
    403: unknown;
    /**
     * Not found (including foreign identifiers)
     */
    404: unknown;
    /**
     * Conflicting intent or archived thread
     */
    409: unknown;
    /**
     * Expected JSON request
     */
    415: unknown;
    /**
     * Unavailable; retry after recovery
     */
    503: unknown;
};
export type ArchiveThreadResponses = {
    /**
     * Archived
     */
    200: ThreadResponse;
};
export type ArchiveThreadResponse = ArchiveThreadResponses[keyof ArchiveThreadResponses];
export type ListMessagesData = {
    body?: never;
    path: {
        threadID: UuidInput;
    };
    query?: never;
    url: '/api/threads/{threadID}/messages';
};
export type ListMessagesErrors = {
    /**
     * Invalid input
     */
    400: unknown;
    /**
     * Authentication required
     */
    401: unknown;
    /**
     * Untrusted origin
     */
    403: unknown;
    /**
     * Not found (including foreign identifiers)
     */
    404: unknown;
    /**
     * Conflicting intent or archived thread
     */
    409: unknown;
    /**
     * Expected JSON request
     */
    415: unknown;
    /**
     * Unavailable; retry after recovery
     */
    503: unknown;
};
export type ListMessagesResponses = {
    /**
     * Public snapshot
     */
    200: MessagesResponse;
};
export type ListMessagesResponse = ListMessagesResponses[keyof ListMessagesResponses];
export type SubmitMessageData = {
    body: MessageSubmissionInput;
    path: {
        threadID: UuidInput;
    };
    query?: never;
    url: '/api/threads/{threadID}/messages';
};
export type SubmitMessageErrors = {
    /**
     * Invalid input
     */
    400: unknown;
    /**
     * Authentication required
     */
    401: unknown;
    /**
     * Untrusted origin
     */
    403: unknown;
    /**
     * Not found (including foreign identifiers)
     */
    404: unknown;
    /**
     * Conflicting intent or archived thread
     */
    409: unknown;
    /**
     * Expected JSON request
     */
    415: unknown;
    /**
     * Unavailable; retry after recovery
     */
    503: unknown;
};
export type SubmitMessageResponses = {
    /**
     * Durably accepted
     */
    202: MessageAccepted;
};
export type SubmitMessageResponse = SubmitMessageResponses[keyof SubmitMessageResponses];
export type CancelRunData = {
    body: RunCancellationInput;
    path: {
        threadID: UuidInput;
        runID: UuidInput;
    };
    query?: never;
    url: '/api/threads/{threadID}/runs/{runID}/cancel';
};
export type CancelRunErrors = {
    /**
     * Invalid input
     */
    400: unknown;
    /**
     * Authentication required
     */
    401: unknown;
    /**
     * Untrusted origin
     */
    403: unknown;
    /**
     * Not found (including foreign identifiers)
     */
    404: unknown;
    /**
     * Conflicting intent or archived thread
     */
    409: unknown;
    /**
     * Expected JSON request
     */
    415: unknown;
    /**
     * Unavailable; retry after recovery
     */
    503: unknown;
};
export type CancelRunResponses = {
    /**
     * Durably accepted cancellation
     */
    202: CancellationAccepted;
};
export type CancelRunResponse = CancelRunResponses[keyof CancelRunResponses];
export type ObserveRunData = {
    /**
     * Official RunAgentInput: threadId and runId must be UUIDs matching the canonical path identifiers. Submitted history, state, context and tools never initiate new execution.
     */
    body: unknown;
    headers?: {
        /**
         * Decimal ordinal at most 9223372036854775807
         */
        'Last-Event-ID'?: string;
    };
    path: {
        threadID: UuidInput;
        runID: UuidInput;
    };
    query?: never;
    url: '/api/threads/{threadID}/runs/{runID}/events';
};
export type ObserveRunErrors = {
    /**
     * Invalid input
     */
    400: unknown;
    /**
     * Authentication required
     */
    401: unknown;
    /**
     * Untrusted origin
     */
    403: unknown;
    /**
     * Not found (including foreign identifiers)
     */
    404: unknown;
    /**
     * Conflicting intent or archived thread
     */
    409: unknown;
    /**
     * Expected JSON request
     */
    415: unknown;
    /**
     * Unavailable; retry after recovery
     */
    503: unknown;
};
export type ObserveRunResponses = {
    /**
     * Official AG-UI SSE, beginning with RUN_STARTED on every reconnect; event IDs are durable public cursors
     */
    200: string;
};
export type ObserveRunResponse = ObserveRunResponses[keyof ObserveRunResponses];
export type ListAssetsData = {
    body?: never;
    path: {
        threadID: UuidInput;
    };
    query?: never;
    url: '/api/threads/{threadID}/assets';
};
export type ListAssetsErrors = {
    /**
     * Invalid input
     */
    400: unknown;
    /**
     * Authentication required
     */
    401: unknown;
    /**
     * Untrusted origin
     */
    403: unknown;
    /**
     * Not found (including foreign identifiers)
     */
    404: unknown;
    /**
     * Conflicting intent or archived thread
     */
    409: unknown;
    /**
     * Expected JSON request
     */
    415: unknown;
    /**
     * Unavailable; retry after recovery
     */
    503: unknown;
};
export type ListAssetsResponses = {
    /**
     * Completed owned assets
     */
    200: AssetsResponse;
};
export type ListAssetsResponse = ListAssetsResponses[keyof ListAssetsResponses];
export type UploadAssetData = {
    body: Blob | File;
    headers: {
        'x-asset-id': UuidInput;
        /**
         * Percent-encoded UTF-8 file name
         */
        'x-file-name': string;
    };
    path: {
        threadID: UuidInput;
    };
    query?: never;
    url: '/api/threads/{threadID}/assets';
};
export type UploadAssetErrors = {
    /**
     * Invalid input
     */
    400: unknown;
    /**
     * Authentication required
     */
    401: unknown;
    /**
     * Untrusted origin
     */
    403: unknown;
    /**
     * Not found (including foreign identifiers)
     */
    404: unknown;
    /**
     * Conflicting intent or archived thread
     */
    409: unknown;
    /**
     * Upload too large or timed out
     */
    413: unknown;
    /**
     * Invalid file
     */
    415: unknown;
    /**
     * Upload unconfirmed; retry same ID and bytes
     */
    503: unknown;
};
export type UploadAssetResponses = {
    /**
     * Exact replay
     */
    200: AssetResponse;
    /**
     * Uploaded
     */
    201: AssetResponse;
};
export type UploadAssetResponse = UploadAssetResponses[keyof UploadAssetResponses];
export type DownloadAssetData = {
    body?: never;
    path: {
        assetID: UuidInput;
    };
    query?: never;
    url: '/api/assets/{assetID}/file';
};
export type DownloadAssetErrors = {
    /**
     * Invalid input
     */
    400: unknown;
    /**
     * Authentication required
     */
    401: unknown;
    /**
     * Untrusted origin
     */
    403: unknown;
    /**
     * Not found (including foreign identifiers)
     */
    404: unknown;
    /**
     * Conflicting intent or archived thread
     */
    409: unknown;
    /**
     * File exceeds download limit
     */
    413: unknown;
    /**
     * Expected JSON request
     */
    415: unknown;
    /**
     * File unavailable or verification failed
     */
    503: unknown;
};
export type DownloadAssetResponses = {
    /**
     * Verified attachment; private, no-store; nosniff; sandbox CSP
     */
    200: Blob | File;
};
export type DownloadAssetResponse = DownloadAssetResponses[keyof DownloadAssetResponses];
