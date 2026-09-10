import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlLang } from '@genoffice/i18n'
import { installScreenTips } from '@genoffice/ui'
import { XMLParser } from 'fast-xml-parser'
import * as HarfBuzz from 'harfbuzzjs'
import JSZip from 'jszip'
import type { OfficeEditorKind } from './bridge'
import './entry.css'
import '@genoffice/ui/tokens.css'

const LABELS: Record<OfficeEditorKind, string> = {
  docs: '文档',
  sheets: '表格',
  slides: '幻灯片',
}

const SHARED_DEPENDENCY_STATUS = {
  react: React.version,
  i18n: htmlLang('zh'),
  ui: typeof installScreenTips === 'function',
  xml: XMLParser.name,
  zip: typeof JSZip.loadAsync === 'function',
  harfbuzz: Object.keys(HarfBuzz).length >= 0,
}

function EntryStatus({
  kind,
  engineExports,
}: {
  kind: OfficeEditorKind
  engineExports: number
}): React.JSX.Element {
  return (
    <main className="office-entry" data-editor-kind={kind}>
      <section className="office-entry-card" aria-live="polite">
        <p className="office-entry-kicker">Mona {LABELS[kind]}编辑器</p>
        <h1>{LABELS[kind]}入口已加载</h1>
        <p className="office-entry-status">独立构建入口已就绪，宿主桥接待接入。</p>
        <p className="office-entry-note">
          当前页面只验证三个入口、公共依赖和产物边界，不伪装成可编辑文档。
        </p>
        <dl className="office-entry-deps">
          <div>
            <dt>React</dt>
            <dd>{SHARED_DEPENDENCY_STATUS.react}</dd>
          </div>
          <div>
            <dt>公共格式库</dt>
            <dd>
              {SHARED_DEPENDENCY_STATUS.xml} · {SHARED_DEPENDENCY_STATUS.zip}
            </dd>
          </div>
          <div>
            <dt>格式引擎</dt>
            <dd>{engineExports > 0 ? '已纳入构建' : '不可用'}</dd>
          </div>
          <div>
            <dt>文本排版</dt>
            <dd>{SHARED_DEPENDENCY_STATUS.harfbuzz ? '已纳入共享依赖' : '不可用'}</dd>
          </div>
        </dl>
        <output className="office-entry-bridge">桥接状态：待接入</output>
      </section>
    </main>
  )
}

export function mountOfficeEntry(kind: OfficeEditorKind, engineExports: number): void {
  const root = document.getElementById('root')
  if (!root) throw new Error('缺少应用根节点。')
  document.documentElement.lang = htmlLang('zh')
  installScreenTips()
  createRoot(root).render(
    <React.StrictMode>
      <EntryStatus kind={kind} engineExports={engineExports} />
    </React.StrictMode>,
  )
}
