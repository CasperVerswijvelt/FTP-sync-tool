export class Response {
    id: number;
    success: boolean;
    data?: unknown;
    error?: ResponseError
}

export class ResponseError {
    type: string;
    subType?: string;
    reason?: string;
}