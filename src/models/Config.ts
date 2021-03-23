export class Config {
    ftp: FTPConfig;
    security?: SecurityConfig;
    downloadDirectory?: string;
    folderSizeDepth?: number;
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
