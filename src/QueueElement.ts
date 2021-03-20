import { FileType } from "basic-ftp";

export class QueueElement {
    path: string;
    name: string;
    type: FileType;
    size: number;
    progress: number;
    isDownloading: boolean;
    isCancelled: boolean;
}