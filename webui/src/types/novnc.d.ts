declare module "@novnc/novnc" {
  interface RFBOptions {
    credentials?: {
      password?: string;
      username?: string;
      target?: string;
    };
    shared?: boolean;
    wsProtocols?: string[];
  }

  interface RFBEventMap {
    connect: CustomEvent;
    disconnect: CustomEvent<{ clean: boolean }>;
    credentialsrequired: CustomEvent;
    securityfailure: CustomEvent<{ detail: string }>;
    clipboard: CustomEvent<{ text: string }>;
    bell: CustomEvent;
    desktopname: CustomEvent<{ name: string }>;
    capabilities: CustomEvent<{ capabilities: string[] }>;
  }

  class RFB {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);
    disconnect(): void;
    sendCredentials(credentials: { password?: string; username?: string; target?: string }): void;
    sendKey(keysym: number, code: string, down?: boolean): void;
    sendCtrlAltDel(): void;
    focus(): void;
    blur(): void;
    machineShutdown(): void;
    machineReboot(): void;
    machineReset(): void;
    clipboardPasteFrom(text: string): void;

    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;

    addEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (this: RFB, ev: RFBEventMap[K]) => void,
    ): void;
    removeEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (this: RFB, ev: RFBEventMap[K]) => void,
    ): void;
  }

  export default RFB;
}
