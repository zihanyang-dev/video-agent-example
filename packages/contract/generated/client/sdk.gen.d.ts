import type { Client, ClientMeta, Options as Options2, RequestResult, ServerSentEventsResult, TDataShape } from './client/index.js';
import type { ArchiveThreadData, ArchiveThreadErrors, ArchiveThreadResponses, CancelRunData, CancelRunErrors, CancelRunResponses, CreateThreadData, CreateThreadErrors, CreateThreadResponses, DownloadAssetData, DownloadAssetErrors, DownloadAssetResponses, GetSessionData, GetSessionResponses, GetThreadData, GetThreadErrors, GetThreadResponses, ListAssetsData, ListAssetsErrors, ListAssetsResponses, ListMessagesData, ListMessagesErrors, ListMessagesResponses, ListThreadsData, ListThreadsErrors, ListThreadsResponses, LogoutData, LogoutErrors, LogoutResponses, ObserveRunData, ObserveRunResponse, ObserveRunResponses, SubmitMessageData, SubmitMessageErrors, SubmitMessageResponses, UpdateThreadData, UpdateThreadErrors, UpdateThreadResponses, UploadAssetData, UploadAssetErrors, UploadAssetResponses } from './types.gen.js';
export type Options<TData extends TDataShape = TDataShape, ThrowOnError extends boolean = boolean, TResponse = unknown> = Options2<TData, ThrowOnError, TResponse> & {
    /**
     * You can provide a client instance returned by `createClient()` instead of
     * individual options. This might be also useful if you want to implement a
     * custom client.
     */
    client?: Client;
    /**
     * You can pass arbitrary values through the `meta` object. This can be
     * used to access values that aren't defined as part of the SDK function.
     */
    meta?: keyof ClientMeta extends never ? Record<string, unknown> : ClientMeta;
};
export declare const logout: <ThrowOnError extends boolean = false>(options: Options<LogoutData, ThrowOnError>) => RequestResult<LogoutResponses, LogoutErrors, ThrowOnError>;
export declare const getSession: <ThrowOnError extends boolean = false>(options?: Options<GetSessionData, ThrowOnError>) => RequestResult<GetSessionResponses, unknown, ThrowOnError>;
export declare const listThreads: <ThrowOnError extends boolean = false>(options?: Options<ListThreadsData, ThrowOnError>) => RequestResult<ListThreadsResponses, ListThreadsErrors, ThrowOnError>;
export declare const createThread: <ThrowOnError extends boolean = false>(options: Options<CreateThreadData, ThrowOnError>) => RequestResult<CreateThreadResponses, CreateThreadErrors, ThrowOnError>;
export declare const getThread: <ThrowOnError extends boolean = false>(options: Options<GetThreadData, ThrowOnError>) => RequestResult<GetThreadResponses, GetThreadErrors, ThrowOnError>;
export declare const updateThread: <ThrowOnError extends boolean = false>(options: Options<UpdateThreadData, ThrowOnError>) => RequestResult<UpdateThreadResponses, UpdateThreadErrors, ThrowOnError>;
export declare const archiveThread: <ThrowOnError extends boolean = false>(options: Options<ArchiveThreadData, ThrowOnError>) => RequestResult<ArchiveThreadResponses, ArchiveThreadErrors, ThrowOnError>;
export declare const listMessages: <ThrowOnError extends boolean = false>(options: Options<ListMessagesData, ThrowOnError>) => RequestResult<ListMessagesResponses, ListMessagesErrors, ThrowOnError>;
export declare const submitMessage: <ThrowOnError extends boolean = false>(options: Options<SubmitMessageData, ThrowOnError>) => RequestResult<SubmitMessageResponses, SubmitMessageErrors, ThrowOnError>;
export declare const cancelRun: <ThrowOnError extends boolean = false>(options: Options<CancelRunData, ThrowOnError>) => RequestResult<CancelRunResponses, CancelRunErrors, ThrowOnError>;
/**
 * Official AG-UI RunAgentInput (https://docs.ag-ui.com/sdk/js/core). Runtime validation uses the official SDK. JSON metadata cannot faithfully describe its custom values; no replacement DTO is generated. Cursor precedence: Last-Event-ID, forwardedProps.after, then 0. Cursors are decimal signed-int64 ordinals authorized against persisted public events.
 */
export declare const observeRun: <ThrowOnError extends boolean = false>(options: Options<ObserveRunData, ThrowOnError, ObserveRunResponse>) => Promise<ServerSentEventsResult<ObserveRunResponses>>;
export declare const listAssets: <ThrowOnError extends boolean = false>(options: Options<ListAssetsData, ThrowOnError>) => RequestResult<ListAssetsResponses, ListAssetsErrors, ThrowOnError>;
/**
 * Raw bounded file bytes. Retry unknown receipts with the identical ID and bytes. Accepted file names exclude control characters; media bytes are verified.
 */
export declare const uploadAsset: <ThrowOnError extends boolean = false>(options: Options<UploadAssetData, ThrowOnError>) => RequestResult<UploadAssetResponses, UploadAssetErrors, ThrowOnError>;
/**
 * Raw file bytes. Generated fetch callers must set parseAs="blob"; automatic MIME parsing can otherwise decode text or JSON attachments.
 */
export declare const downloadAsset: <ThrowOnError extends boolean = false>(options: Options<DownloadAssetData, ThrowOnError>) => RequestResult<DownloadAssetResponses, DownloadAssetErrors, ThrowOnError>;
