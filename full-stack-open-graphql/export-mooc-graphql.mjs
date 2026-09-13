#!/usr/bin/env node

import { access, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join } from 'node:path'

const API = 'https://courses.mooc.fi/api/v0'
const ORGANIZATION_SLUG = 'uh-cs'
const COURSE_SLUG = 'full-stack-open-graphql'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = SCRIPT_DIR
const ASSETS_DIR = join(OUTPUT_DIR, 'assets')

const fetchWithTimeout = (url) => fetch(url, { signal: AbortSignal.timeout(30_000) })

const fetchJson = async (url) => {
  const response = await fetchWithTimeout(url)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`)
  return response.json()
}

const decodeHtml = (value = '') => value
  .replaceAll('&nbsp;', ' ')
  .replaceAll('&amp;', '&')
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"')
  .replaceAll('&#8217;', "'")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))

const htmlToMarkdown = (html = '') => {
  const text = String(html)
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => `\n\n\`\`\`\n${decodeHtml(code).trim()}\n\`\`\`\n\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => `\`${decodeHtml(code)}\``)
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `[${stripHtml(label)}](${href})`)
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(?:li|p|div|h[1-6]|blockquote|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
  return decodeHtml(stripHtml(text)).replace(/\n{3,}/g, '\n\n').trim()
}

const stripHtml = (value = '') => String(value).replace(/<[^>]+>/g, '')

const safeFileStem = (value) => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'chapter'

const collectImageUrls = (block, found) => {
  const attributes = block.attributes ?? {}
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string' && /^(https?:)?\/\//.test(value) && /(?:image|img|url|src)/i.test(key)) {
      found.add(value.startsWith('//') ? `https:${value}` : value)
    }
  }
  for (const child of block.innerBlocks ?? []) collectImageUrls(child, found)
}

const renderBlock = (block, imagePaths, exercises) => {
  const attributes = block.attributes ?? {}
  const content = attributes.content ?? attributes.text ?? attributes.description ?? ''

  switch (block.name) {
    case 'core/heading': {
      const level = Math.min(Math.max(Number(attributes.level) || 2, 1), 6)
      return `${'#'.repeat(level)} ${htmlToMarkdown(content)}`
    }
    case 'core/paragraph':
      return htmlToMarkdown(content)
    case 'core/code':
      return `\`\`\`${attributes.language ?? ''}\n${decodeHtml(content).trim()}\n\`\`\``
    case 'core/list': {
      const items = (block.innerBlocks ?? []).map((item, index) => {
        const marker = attributes.ordered ? `${index + 1}.` : '-'
        const text = htmlToMarkdown(item.attributes?.content ?? '').replace(/\n+/g, ' ')
        return text ? `${marker} ${text}` : ''
      }).filter(Boolean)
      return items.length ? items.join('\n') : htmlToMarkdown(content)
    }
    case 'core/quote':
      return htmlToMarkdown(content).split('\n').map((line) => `> ${line}`).join('\n')
    case 'core/image': {
      const url = attributes.url ?? attributes.src
      if (!url) return ''
      const source = url.startsWith('//') ? `https:${url}` : url
      const path = imagePaths.get(source)
      const alt = htmlToMarkdown(attributes.alt ?? attributes.altText ?? attributes.caption ?? 'Course image')
      const caption = htmlToMarkdown(attributes.caption ?? '')
      return [path ? `![${alt}](${path})` : `![${alt}](${source})`, caption && `_${caption}_`].filter(Boolean).join('\n\n')
    }
    case 'moocfi/exercise': {
      const detail = exercises.get(attributes.id)
      const title = htmlToMarkdown(detail?.exercise?.name ?? attributes.title ?? attributes.name ?? 'Exercise')
      const tasks = detail?.current_exercise_slide?.exercise_tasks ?? []
      const assignment = tasks.flatMap((task) => task.assignment ?? [])
      const body = assignment.map((item) => renderBlock(item, imagePaths, exercises)).filter(Boolean).join('\n\n')
      return [`## Exercise: ${title}`, body || '> Exercise details were unavailable during export.'].join('\n\n')
    }
    default:
      return htmlToMarkdown(content)
  }
}

const downloadAsset = async (url, number) => {
  const urlExtension = extname(new URL(url).pathname)
  const fileName = `image-${String(number).padStart(3, '0')}${urlExtension || '.bin'}`
  const outputPath = join(ASSETS_DIR, fileName)
  try {
    await access(outputPath)
    return `assets/${fileName}`
  } catch {
    const response = await fetchWithTimeout(url)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`)
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()))
  }
  return `assets/${fileName}`
}

const main = async () => {
  await mkdir(ASSETS_DIR, { recursive: true })
  console.log('Fetching course metadata…')
  const organization = await fetchJson(`${API}/main-frontend/org/${ORGANIZATION_SLUG}`)
  const courses = await fetchJson(`${API}/main-frontend/organizations/${organization.id}/courses`)
  const course = courses.find((item) => item.slug === COURSE_SLUG)
  if (!course) throw new Error(`Could not find course ${COURSE_SLUG}`)

  const pages = await fetchJson(`${API}/course-material/courses/${course.id}/pages`)
  const exerciseIds = new Set()
  const imageUrls = new Set()
  const collectReferences = (block) => {
    collectImageUrls(block, imageUrls)
    if (block.name === 'moocfi/exercise' && block.attributes?.id) exerciseIds.add(block.attributes.id)
    for (const child of block.innerBlocks ?? []) collectReferences(child)
  }
  for (const page of pages) for (const block of page.content ?? []) collectReferences(block)

  console.log(`Fetching ${exerciseIds.size} exercise descriptions…`)
  const exerciseEntries = await Promise.all([...exerciseIds].map(async (id) => {
    try {
      return [id, await fetchJson(`${API}/course-material/exercises/${id}`)]
    } catch (error) {
      console.warn(`Could not download exercise ${id}: ${error.message}`)
      return [id, null]
    }
  }))
  const exercises = new Map(exerciseEntries.filter(([, detail]) => detail))
  for (const detail of exercises.values()) {
    for (const task of detail.current_exercise_slide?.exercise_tasks ?? []) {
      for (const block of task.assignment ?? []) collectImageUrls(block, imageUrls)
    }
  }

  const imagePaths = new Map()
  const sortedImageUrls = [...imageUrls].sort()
  await Promise.all(sortedImageUrls.map(async (url, index) => {
    const imageNumber = index + 1
    try {
      imagePaths.set(url, await downloadAsset(url, imageNumber))
      console.log(`Downloaded image ${imageNumber}/${imageUrls.size}`)
    } catch (error) {
      console.warn(`Could not download ${url}: ${error.message}`)
    }
  }))

  const exportedAt = new Date().toISOString()
  const chapters = []
  for (const page of pages.filter((item) => item.url_path !== '/')) {
    const order = Number((page.url_path.match(/chapter-(\d+)/) ?? [])[1]) || 999
    const fileName = `chapter-${String(order).padStart(2, '0')}-${safeFileStem(page.title.replace(/^Chapter \d+:\s*/i, ''))}.md`
    const body = (page.content ?? []).map((block) => renderBlock(block, imagePaths, exercises)).filter(Boolean).join('\n\n')
    const markdown = [
      `# ${page.title}`,
      '',
      `Source: https://courses.mooc.fi/org/${ORGANIZATION_SLUG}/courses/${COURSE_SLUG}${page.url_path}`,
      `Exported: ${exportedAt}`,
      '',
      body,
      '',
    ].join('\n')
    await writeFile(join(OUTPUT_DIR, fileName), markdown)
    chapters.push({ title: page.title, url_path: page.url_path, file: fileName, updated_at: page.updated_at })
  }

  chapters.sort((a, b) => a.file.localeCompare(b.file))
  await writeFile(join(OUTPUT_DIR, 'raw-pages.json'), `${JSON.stringify(pages, null, 2)}\n`)
  await writeFile(join(OUTPUT_DIR, 'raw-exercises.json'), `${JSON.stringify(Object.fromEntries(exercises), null, 2)}\n`)
  await writeFile(join(OUTPUT_DIR, 'manifest.json'), `${JSON.stringify({ exported_at: exportedAt, course: { id: course.id, slug: course.slug, name: course.name }, chapters, images: Object.fromEntries(imagePaths) }, null, 2)}\n`)
  await writeFile(join(OUTPUT_DIR, 'README.md'), [
    '# Full Stack Open: GraphQL — offline export',
    '',
    'This is an AI-friendly export of the publicly available course material. Markdown preserves reading order; `assets/` contains the original downloaded images; `raw-pages.json` and `raw-exercises.json` preserve the API blocks for fidelity.',
    '',
    '## Chapters',
    '',
    ...chapters.map((chapter) => `- [${chapter.title}](./${chapter.file})`),
    '',
    `Source: https://courses.mooc.fi/org/${ORGANIZATION_SLUG}/courses/${COURSE_SLUG}`,
    `Exported: ${exportedAt}`,
    '',
  ].join('\n'))

  console.log(`Exported ${chapters.length} chapters and ${imagePaths.size} images to ${OUTPUT_DIR}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
