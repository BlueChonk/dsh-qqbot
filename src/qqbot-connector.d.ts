declare module '@tencent-connect/qqbot-connector' {
  export interface QrConnectCredentials {
    appId: string;
    appSecret: string;
    userOpenid?: string;
  }

  export interface QrConnectOptions {
    displayQrCodeToConsole?: boolean;
    signal?: AbortSignal;
    source?: string;
  }

  export function qrConnect(options?: Omit<QrConnectOptions, 'displayQrCodeToConsole'>): Promise<QrConnectCredentials[]>;
}
