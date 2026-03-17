declare module "electron" {
  export const app: {
    isPackaged: boolean
    getVersion(): string
    getPath(name: string): string
    getAppPath(): string
    dock?: { setIcon(path: unknown): void }
    setName(name: string): void
    setPath(name: string, path: string): void
    commandLine: {
      hasSwitch(name: string): boolean
      getSwitchValue(name: string): string
      appendSwitch(name: string, value?: string): void
    }
    requestSingleInstanceLock(): boolean
    whenReady(): Promise<void>
    on(event: string, cb: (...args: any[]) => void): void
    quit(): void
    relaunch(opts?: unknown): void
    exit(code?: number): void
    setAsDefaultProtocolClient(scheme: string): void
  }

  export class BrowserWindow {
    constructor(opts: unknown)
    static getAllWindows(): BrowserWindow[]
    static fromWebContents(contents: unknown): BrowserWindow | null
    static getFocusedWindow(): BrowserWindow | null
    webContents: {
      on(event: string, cb: (...args: any[]) => void): void
      executeJavaScript(code: string): Promise<unknown>
      setZoomFactor(factor: number): void
      send(channel: string, ...args: unknown[]): void
      toggleDevTools(): void
    }
    loadURL(url: string): Promise<void>
    loadFile(path: string): Promise<void>
    show(): void
    focus(): void
    isFocused(): boolean
    reload(): void
    close(): void
    setTitleBarOverlay(opts: unknown): void
    setMenuBarVisibility(visible: boolean): void
  }

  export const nativeImage: {
    createFromPath(path: string): unknown
  }

  export const nativeTheme: {
    shouldUseDarkColors: boolean
  }

  export const dialog: any
  export const ipcMain: any
  export const ipcRenderer: any
  export const Notification: any
  export const clipboard: any
  export const shell: any
  export const Menu: any
  export const contextBridge: any
  export type Event = any

  export type IpcMainEvent = any
  export type IpcMainInvokeEvent = any
}

declare namespace Electron {
  interface MenuItemConstructorOptions {
    [key: string]: unknown
  }
}

declare global {
  namespace NodeJS {
    interface Process {
      resourcesPath?: string
    }
  }

  interface Process {
    resourcesPath?: string
  }
}


