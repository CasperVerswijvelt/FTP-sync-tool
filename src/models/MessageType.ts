export enum MessageType {
    QUEUE = "queue",
    QUEUE_ELEMENT = "queueElement",
    LIST = "list",
    LIST_ELEMENT = "listElement",
    DOWNLOAD_COMPLETE = "downloadComplete",
    DOWNLOAD_ERROR = "downloadError",
    QUEUE_CANCEL_ERROR = "queueCancelError",
    QUEUE_CANCEL_REMNANTS_REMOVE_ERROR = "queueCancelError",
    QUEUE_ELEMENT_SIZE_ERROR = "queueElementSizeError"
}