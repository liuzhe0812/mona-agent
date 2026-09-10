import '../vendor/genoffice/apps/slides/src/shared/ipc'

declare module '../vendor/genoffice/apps/slides/src/shared/ipc' {
  interface DesktopFilesApi {
    copyImageToClipboard: (...args: unknown[]) => Promise<boolean>
    onLanguageChanged: (listener: (lang: 'zh') => void) => () => void
  }
}
