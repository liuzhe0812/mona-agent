#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDirectory, '..')
const repositoryRoot = resolve(packageRoot, '..', '..')
const genofficeRoot = join(packageRoot, 'vendor', 'genoffice')
const sidecarRoot = join(genofficeRoot, 'apps', 'sheets', 'native', 'xlsx-engine')
const resourceRoot = join(repositoryRoot, 'src-tauri', 'resources', 'office-editor', 'licenses')

const packageLockPath = join(packageRoot, 'package-lock.json')
const cargoLockPath = join(sidecarRoot, 'Cargo.lock')
const cargoManifestPath = join(sidecarRoot, 'Cargo.toml')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function packageNameFromLockPath(lockPath) {
  const packagePath = lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length)
  const parts = packagePath.split('/')
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function installedApacheLicense(lockPath) {
  const licensePath = join(packageRoot, lockPath, 'LICENSE')
  if (!existsSync(licensePath)) return null

  try {
    const licenseText = readFileSync(licensePath, 'utf8')
    if (/Apache\s+License\s+Version\s+2\.0/i.test(licenseText)) {
      return {
        license: 'Apache-2.0',
        evidence: 'package LICENSE (Apache License Version 2.0)',
      }
    }
  } catch {
    return null
  }

  return null
}

function npmRuntimePackages(lock) {
  const directNames = new Set(Object.keys(lock.packages['']?.dependencies ?? {}))
  const packages = []

  for (const [lockPath, metadata] of Object.entries(lock.packages)) {
    if (!lockPath || metadata.dev === true) continue

    const name = packageNameFromLockPath(lockPath)
    if (!metadata.version) {
      packages.push({
        name,
        version: 'unknown',
        scope: directNames.has(name) ? 'direct' : 'transitive',
        license: null,
        evidence: null,
        source: null,
        integrity: null,
        manualReview: 'Version metadata is missing from package-lock.json.',
      })
      continue
    }

    const declaredLicense =
      typeof metadata.license === 'string' && metadata.license.trim() ? metadata.license : null
    const fallbackLicense = declaredLicense ? null : installedApacheLicense(lockPath)
    packages.push({
      name,
      version: metadata.version,
      scope: directNames.has(name) ? 'direct' : 'transitive',
      license: declaredLicense ?? fallbackLicense?.license ?? null,
      evidence: fallbackLicense?.evidence ?? null,
      source: typeof metadata.resolved === 'string' ? metadata.resolved : null,
      integrity: typeof metadata.integrity === 'string' ? metadata.integrity : null,
      manualReview: declaredLicense || fallbackLicense
        ? null
        : 'License metadata is missing from package-lock.json; confirm the package license before release.',
    })
  }

  return packages.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  )
}

function parseCargoPackage(block) {
  const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1]
  const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1]
  const source = /^source\s*=\s*"([^"]+)"/m.exec(block)?.[1] ?? null
  const dependenciesBlock = /^dependencies\s*=\s*\[(.*?)^\]/ms.exec(block)?.[1] ?? ''
  const dependencies = [...dependenciesBlock.matchAll(/^\s*"([^"]+)"/gm)].map((match) => match[1])
  return { name, version, source, dependencies }
}

function parseCargoLock(path) {
  const contents = readFileSync(path, 'utf8')
  return contents
    .split(/\n\[\[package\]\]\n/)
    .slice(1)
    .map(parseCargoPackage)
    .filter((pkg) => pkg.name && pkg.version)
}

function cargoDependencyName(dependency) {
  return dependency.split(/\s+/)[0]
}

function cargoDependencyVersion(dependency) {
  const match = /\s(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(dependency)
  return match?.[1] ?? null
}

function cargoRuntimePackageIds(lockPackages, manifest, rootPackage) {
  const dependencyHeader = '[dependencies]'
  const dependencyStart = manifest.indexOf(dependencyHeader)
  const dependencyBody = dependencyStart < 0 ? '' : manifest.slice(dependencyStart + dependencyHeader.length)
  const nextSection = dependencyBody.search(/\r?\n\[[^\r\n]+\]/)
  const dependencySection = nextSection < 0 ? dependencyBody : dependencyBody.slice(0, nextSection)
  const directNames = new Set(
    [...dependencySection.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:\{|"|\d)/gm)].map(
      (match) => match[1],
    ),
  )
  const byName = new Map()

  for (const pkg of lockPackages) {
    const packages = byName.get(pkg.name) ?? []
    packages.push(pkg)
    byName.set(pkg.name, packages)
  }

  const resolveDependency = (dependency) => {
    const name = cargoDependencyName(dependency)
    const version = cargoDependencyVersion(dependency)
    const candidates = byName.get(name) ?? []
    if (version) return candidates.filter((pkg) => pkg.version === version)
    return candidates
  }

  const rootDependencies = rootPackage.dependencies.filter((dependency) =>
    directNames.has(cargoDependencyName(dependency)),
  )
  const root = { name: rootPackage.name, version: rootPackage.version, source: rootPackage.source, dependencies: rootDependencies }
  const queue = rootDependencies.flatMap(resolveDependency)
  const selected = new Map([[`${root.name}@${root.version}`, root]])

  while (queue.length) {
    const pkg = queue.shift()
    if (!pkg) continue
    const id = `${pkg.name}@${pkg.version}`
    if (selected.has(id)) continue
    selected.set(id, pkg)
    queue.push(...pkg.dependencies.flatMap(resolveDependency))
  }

  return [...selected.values()]
}

function cargoMetadata(manifestPath) {
  const result = spawnSync(
    'cargo',
    ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifestPath],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  if (result.status !== 0 || !result.stdout.trim()) return new Map()

  try {
    const metadata = JSON.parse(result.stdout)
    return new Map(
      metadata.packages.map((pkg) => [
        `${pkg.name}@${pkg.version}`,
        {
          license: typeof pkg.license === 'string' ? pkg.license : null,
          repository: typeof pkg.repository === 'string' ? pkg.repository : null,
          licenseFile: typeof pkg.license_file === 'string' ? pkg.license_file : null,
        },
      ]),
    )
  } catch {
    return new Map()
  }
}

function cargoRuntimePackages() {
  const lockPackages = parseCargoLock(cargoLockPath)
  const rootPackage = lockPackages.find((pkg) => pkg.name === 'xlsx-sidecar' && !pkg.source)
  if (!rootPackage) throw new Error('xlsx-sidecar package is missing from Cargo.lock')

  const manifest = readFileSync(cargoManifestPath, 'utf8')
  const selected = cargoRuntimePackageIds(lockPackages, manifest, rootPackage)
  const metadata = cargoMetadata(cargoManifestPath)

  return selected
    .map((pkg) => {
      const info = metadata.get(`${pkg.name}@${pkg.version}`)
      const isSidecar = pkg.name === rootPackage.name && pkg.version === rootPackage.version
      return {
        name: pkg.name,
        version: pkg.version,
        scope: isSidecar ? 'sidecar' : 'runtime',
        license: info?.license ?? null,
        source: pkg.source?.startsWith('registry+')
          ? `https://crates.io/crates/${pkg.name}/${pkg.version}`
          : null,
        repository: info?.repository ?? null,
        manualReview: info?.license
          ? null
          : info?.licenseFile
            ? 'The crate declares a license file instead of an SPDX expression; confirm its contents before release.'
            : 'License metadata is unavailable from Cargo metadata; confirm the crate license before release.',
      }
    })
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
    )
}

function copyBundledLicense(sourceName, destinationName) {
  const sourcePath = join(packageRoot, sourceName)
  if (!existsSync(sourcePath)) throw new Error(`Missing source license: ${sourceName}`)
  copyFileSync(sourcePath, join(resourceRoot, destinationName))
}

function copyGenofficeLicense(sourcePath, destinationName) {
  if (!existsSync(sourcePath)) throw new Error(`Missing source license: ${relative(repositoryRoot, sourcePath)}`)
  copyFileSync(sourcePath, join(resourceRoot, destinationName))
}

function sourceLabel(pkg) {
  if (pkg.source) return pkg.source
  if (pkg.repository) return pkg.repository
  return 'source URL unavailable'
}

function formatLicense(pkg) {
  if (pkg.license) return pkg.license
  return 'LICENSE NOT RESOLVED — MANUAL REVIEW REQUIRED'
}

function formatNpmEntry(pkg) {
  const details = [pkg.scope, `source: ${sourceLabel(pkg)}`]
  if (pkg.integrity) details.push(`integrity: ${pkg.integrity}`)
  if (pkg.evidence) details.push(`evidence: ${pkg.evidence}`)
  const review = pkg.manualReview ? `\n  Review: ${pkg.manualReview}` : ''
  return `- ${pkg.name}@${pkg.version} — ${formatLicense(pkg)} — ${details.join('; ')}${review}`
}

function formatCargoEntry(pkg) {
  const details = [pkg.scope, `source: ${sourceLabel(pkg)}`]
  const review = pkg.manualReview ? `\n  Review: ${pkg.manualReview}` : ''
  return `- ${pkg.name}@${pkg.version} — ${formatLicense(pkg)} — ${details.join('; ')}${review}`
}

function renderNotices(npmPackages, cargoPackages) {
  const reviewItems = [...npmPackages, ...cargoPackages].filter((pkg) => pkg.manualReview)
  const lines = [
    'Mona Office Editor — third-party runtime license index',
    '',
    'This file is generated from the exact lock files used by the Office editor build.',
    'It records package versions, license metadata, and source locations; it does not',
    'replace the license texts shipped beside it.',
    '',
    'Inputs:',
    '- webui/office-editor/package-lock.json (production entries; dev=true entries omitted)',
    '- webui/office-editor/vendor/genoffice/apps/sheets/native/xlsx-engine/Cargo.lock',
    '  (the xlsx-sidecar [dependencies] closure; dev-only dependencies omitted)',
    '',
    'Included license texts:',
    '- LICENSE — GenOffice Apache License 2.0',
    '- NOTICE — GenOffice attribution and Unicode data notice',
    '- LICENSE-UNICODE.txt — Unicode License v3',
    '- LICENSE-emf-converter.txt — runtime EMF converter Apache License 2.0',
    '',
    `## JavaScript runtime packages (${npmPackages.length})`,
    '',
    ...npmPackages.map(formatNpmEntry),
    '',
    `## Rust runtime crates (${cargoPackages.length})`,
    '',
    ...cargoPackages.map(formatCargoEntry),
    '',
    '## Manual review',
    '',
    ...(reviewItems.length
      ? reviewItems.map(
          (pkg) => `- ${pkg.name}@${pkg.version}: ${pkg.manualReview}`,
        )
      : ['- None.']),
    '',
    'Excluded by design: GenOffice test-fixture licenses and font licenses. The',
    'Mona editor does not ship those fixtures or bundled fonts in this resource.',
    '',
  ]
  return `${lines.join('\n')}`
}

function main() {
  const lock = readJson(packageLockPath)
  if (lock.lockfileVersion !== 3) throw new Error('Expected npm lockfileVersion 3')

  mkdirSync(resourceRoot, { recursive: true })
  copyBundledLicense('LICENSE', 'LICENSE')
  copyBundledLicense('NOTICE', 'NOTICE')
  copyGenofficeLicense(join(genofficeRoot, 'LICENSE-UNICODE.txt'), 'LICENSE-UNICODE.txt')
  copyGenofficeLicense(
    join(genofficeRoot, 'packages', 'docx-engine', 'src', 'vendor', 'emf-converter', 'LICENSE'),
    'LICENSE-emf-converter.txt',
  )

  const npmPackages = npmRuntimePackages(lock)
  const cargoPackages = cargoRuntimePackages()
  writeFileSync(
    join(resourceRoot, 'THIRD-PARTY-NOTICES.txt'),
    renderNotices(npmPackages, cargoPackages),
    'utf8',
  )

  console.log(
    `Generated ${relative(repositoryRoot, resourceRoot)}: ${npmPackages.length} npm packages, ${cargoPackages.length} Rust crates, ${npmPackages.filter((pkg) => pkg.manualReview).length + cargoPackages.filter((pkg) => pkg.manualReview).length} manual-review entries.`,
  )
}

main()
