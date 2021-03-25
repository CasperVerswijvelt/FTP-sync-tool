export class Config {
    ftp: FTPConfig;
    security?: SecurityConfig;
    folderSizeDepth?: number;
    download?: DownloadConfig;
}

export class FTPConfig {
    host: string;
    user?: string;
    password?: string;
    secure?: boolean | "implicit";
    certificate?: string;
    checkServerIdentity?: boolean;
}

export class SecurityConfig {
    websocketOrigin?: string;
}

export class DownloadConfig {
    downloadDirectory?: string;
    removeOnCancel?: boolean;
    removeOnError?: boolean;
}
