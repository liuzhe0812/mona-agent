import { gzipSync } from 'node:zlib'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outputRoot = resolve(packageRoot, '../../src-tauri/dist/office-editor')
const reportPath = resolve(outputRoot, 'bundle-size-report.json')
const resourceRoot = resolve(packageRoot, '../../src-tauri/resources/office-editor')
const templateRoot = resolve(resourceRoot, 'templates')
const licenseRoot = resolve(resourceRoot, 'licenses')
const manifestPath = resolve(resourceRoot, 'manifest.json')
const sourceCommit = '583a045212f871943afb8ca4503fcb5ddf99a23f'
const forbidden = /(^|[\\/_.-])(electron|pdf|ocr|example|examples|fixture|fixtures|test|tests)(?=$|[\\/_.-])/i
const forbiddenExtensions = new Set(['.map', '.ttf', '.otf', '.woff', '.woff2', '.eot'])

async function walk(dir, files = []) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) await walk(path, files)
    else files.push(path)
  }
  return files
}

function byteReport(path, root) {
  return readFile(path).then((data) => ({
    path: relative(root, path).replaceAll('\\', '/'),
    bytes: data.byteLength,
    gzipBytes: gzipSync(data, { mtime: 0 }).byteLength,
    extension: extname(path).toLowerCase(),
  }))
}

function containedPath(root, relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty relative path`)
  }
  const candidate = resolve(root, relativePath)
  const fromRoot = relative(root, candidate)
  if (
    fromRoot.length === 0 ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} escapes ${root}`)
  }
  return candidate
}

function scriptsInHtml(html, root) {
  const refs = [...html.matchAll(/(?:src|href)="([^\"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => /^(?:\.\.\/|\.\/)+assets\//.test(value))
  return refs.map((value) => resolve(root, value))
}

const files = await walk(outputRoot)
const bundleFiles = files.filter((path) => path !== reportPath)
if (bundleFiles.length === 0) throw new Error(`No build output found at ${outputRoot}`)

const violations = bundleFiles
  .filter((path) => forbiddenExtensions.has(extname(path).toLowerCase()) || forbidden.test(path))
  .map((path) => relative(outputRoot, path).replaceAll('\\', '/'))
if (violations.length > 0) throw new Error(`Disallowed bundle files: ${violations.join(', ')}`)

const fileReports = await Promise.all(bundleFiles.map((path) => byteReport(path, outputRoot)))
fileReports.sort((a, b) => a.path.localeCompare(b.path))
const fileByPath = new Map(fileReports.map((file) => [file.path, file]))
const htmlPaths = fileReports.filter((file) => file.extension === '.html').map((file) => file.path)
const entries = []
for (const htmlPath of htmlPaths) {
  const html = await readFile(resolve(outputRoot, htmlPath), 'utf8')
  const refs = scriptsInHtml(html, resolve(outputRoot, htmlPath, '..'))
  const assets = refs
    .map((path) => fileByPath.get(relative(outputRoot, path).replaceAll('\\', '/')))
    .filter(Boolean)
  entries.push({
    name: htmlPath.endsWith('/index.html') ? htmlPath.split('/')[0] : basename(htmlPath, '.html'),
    html: htmlPath,
    assets: assets.map(({ path, bytes, gzipBytes }) => ({ path, bytes, gzipBytes })),
    bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    gzipBytes: assets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
  })
}

const expectedEntries = ['docs/index.html', 'sheets/index.html', 'slides/index.html']
const actualEntries = entries.map((entry) => entry.html).sort()
if (actualEntries.join('|') !== expectedEntries.join('|')) {
  throw new Error(`Expected three Office entries, found: ${actualEntries.join(', ')}`)
}

const sharedChunks = fileReports
  .filter((file) => file.extension === '.js' && /\/shared-[^/]+\.js$/.test(`/${file.path}`))
  .map(({ path, bytes, gzipBytes }) => ({ path, bytes, gzipBytes }))
if (
  !sharedChunks.some((chunk) => /\/shared-react-[^/]+\.js$/.test(`/${chunk.path}`)) ||
  !sharedChunks.some((chunk) => /\/shared-genoffice-ui-[^/]+\.js$/.test(`/${chunk.path}`)) ||
  !sharedChunks.some((chunk) => /\/shared-format-[^/]+\.js$/.test(`/${chunk.path}`))
) {
  throw new Error('Expected React, GenOffice UI, and format shared chunks')
}
const total = fileReports.reduce(
  (summary, file) => ({
    bytes: summary.bytes + file.bytes,
    gzipBytes: summary.gzipBytes + file.gzipBytes,
  }),
  { bytes: 0, gzipBytes: 0 },
)
let officeManifest
try {
  officeManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
} catch (error) {
  throw new Error(`Invalid Office resource manifest at ${manifestPath}`, { cause: error })
}
const expectedPlatform =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform
const expectedArch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
if (
  officeManifest?.schemaVersion !== 1 ||
  officeManifest?.platform !== expectedPlatform ||
  officeManifest?.arch !== expectedArch ||
  typeof officeManifest?.xlsxSidecar?.path !== 'string'
) {
  throw new Error(`Invalid Office resource manifest metadata at ${manifestPath}`)
}
const sidecarPath = containedPath(resourceRoot, officeManifest.xlsxSidecar.path, 'xlsxSidecar.path')
const sidecar = await stat(sidecarPath).then(() => byteReport(sidecarPath, resourceRoot), () => null)
if (!sidecar) throw new Error(`Configured xlsx sidecar not found at ${sidecarPath}`)
const templates = await walk(templateRoot)
const templateReports = await Promise.all(templates.map((path) => byteReport(path, resourceRoot)))
templateReports.sort((a, b) => a.path.localeCompare(b.path))
const licenseFiles = await walk(licenseRoot)
const licenseReports = await Promise.all(licenseFiles.map((path) => byteReport(path, resourceRoot)))
licenseReports.sort((a, b) => a.path.localeCompare(b.path))
const manifest = await byteReport(manifestPath, resourceRoot)
const resourceTotal = [sidecar, manifest, ...templateReports, ...licenseReports].reduce(
  (summary, file) => ({
    bytes: summary.bytes + file.bytes,
    gzipBytes: summary.gzipBytes + file.gzipBytes,
  }),
  { bytes: 0, gzipBytes: 0 },
)
const totalWithSidecar = {
  bytes: total.bytes + (sidecar?.bytes ?? 0),
  gzipBytes: total.gzipBytes + (sidecar?.gzipBytes ?? 0),
}
const totalWithResources = {
  bytes: total.bytes + resourceTotal.bytes,
  gzipBytes: total.gzipBytes + resourceTotal.gzipBytes,
}

const report = {
  schemaVersion: 1,
  sourceCommit,
  sourcemap: false,
  fonts: false,
  output: 'src-tauri/dist/office-editor',
  forbiddenAssets: {
    embeddedFontsAbsent: true,
    electronAssetsAbsent: true,
    pdfAssetsAbsent: true,
    ocrAssetsAbsent: true,
    testAssetsAbsent: true,
  },
  entries,
  sharedChunks,
  files: fileReports,
  total,
  sidecar,
  manifest,
  templates: templateReports,
  licenses: licenseReports,
  resourceTotal,
  totalWithSidecar,
  totalWithResources,
}

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(
  `bundle report: ${report.entries.length} entries, ${fileReports.length} files, ` +
    `${total.bytes} bytes (${total.gzipBytes} gzip), ` +
    `${totalWithResources.bytes} bytes with Office resources (${totalWithResources.gzipBytes} gzip)\n`,
)
