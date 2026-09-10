import type {
  DesktopApi,
} from '../vendor/genoffice/apps/docs/src/shared/ipc'
import type { DesktopApi as SheetsDesktopApi } from '../vendor/genoffice/apps/sheets/src/shared/desktop-api'
import type { ProjectApi } from '../vendor/genoffice/packages/project-store/src/index'

declare module '../vendor/genoffice/apps/slides/src/shared/ipc' {
  interface DesktopFilesApi extends DesktopApi {}
}

declare global {
  interface Window {
    desktopApi: SheetsDesktopApi
    projectApi: ProjectApi
  }
}

export {}
