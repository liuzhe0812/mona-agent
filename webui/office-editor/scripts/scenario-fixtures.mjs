#!/usr/bin/env node
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const officeRoot = resolve(dirname(scriptPath), '..')
const repoRoot = resolve(officeRoot, '../..')
const scenarioDirectory = resolve(officeRoot, 'tests/scenarios')
const scenarioCatalogPath = resolve(officeRoot, 'mona/presets/scenarios.json')
const scenarioPagesPath = resolve(officeRoot, 'mona/presets/scenario-pages.json')
const signaturesPath = resolve(scenarioDirectory, 'signatures.json')
const fixturePath = resolve(scenarioDirectory, 'content.json')
const catalogPaths = [
  resolve(officeRoot, 'mona/presets/catalog.json'),
  resolve(officeRoot, 'mona/presets/extended.json'),
  resolve(scenarioPagesPath),
]
const legacySemanticsPath = resolve(officeRoot, 'mona/presets/legacy-semantics.json')
const allowedAssetRoots = [
  resolve(officeRoot, 'tests/presets/assets'),
  resolve(repoRoot, 'mona/skills/mona-pptx/assets/native'),
]

const scenarioCopy = {
  'business-report': {
    subject: '季度经营复盘', summary: '季度经营样例；数值仅作排版演示。', takeaway: '先稳交付，再看增长', shortMetric: '示例 +8%', tinyMetric: '示例8%',
    titles: { cover: '第三季度经营复盘', context: '交付目标与统计口径', metrics: '交付与回款关键指标', trend: '按期交付逐季改善', observation: '平均交付周期变化', comparison: '目标与实际完成情况', actions: '延期项目逐项定责', result: '下阶段优先保障续约' },
    nodes: ['目标口径', '进度跟踪', '成本复核', '交付确认', '风险排序', '行动复盘'],
    items: ['统一季度收入和回款口径。', '重点项目每周核对里程碑。', '延期事项标出负责人和时间。', '先保障高价值客户按期交付。', '复核成本变化与项目毛利。', '下轮检查续约和交付质量。'],
    categories: ['一季度', '二季度', '三季度', '四季度'],
    series: [{ name: '按期交付（演示）', values: [78, 82, 87, 92] }, { name: '计划完成（演示）', values: [80, 84, 88, 90] }],
    axes: { x: '经营影响', y: '执行难度' },
  },
  'product-showcase': {
    subject: '协作工作台产品展示', summary: '产品功能与指标均为排版演示。', takeaway: '减少重复准备', shortMetric: '示例 3步', tinyMetric: '3步演示',
    titles: { cover: '让任务与成果留在同一工作台', statement: '从输入主题到继续编辑', breakdown: '工作台的四项能力', metrics: '制作准备时间对照', relationship: '内容、任务与文件协作', image: '实际界面与使用场景', case: '功能如何解决具体问题', comparison: '人工准备与流程复用', process: '从主题推进到交付' },
    nodes: ['主题输入', '素材整理', '场景制作', '文件检查', '结果复用', '团队协作'],
    items: ['围绕交付目标组织工作。', '集中整理可用素材与来源。', '逐页制作并检查内容。', '保存可编辑成果供后续复用。', '保留任务状态和修改入口。', '示例截图为历史界面素材。'],
    categories: ['人工准备', '流程复用', '完成检查'],
    series: [{ name: '准备分钟（演示）', values: [50, 30, 24] }, { name: '检查步骤（演示）', values: [6, 4, 3] }],
    axes: { x: '使用价值', y: '实施难度' },
  },
  'technical-proposal': {
    subject: '桌面工作台技术方案', summary: '压测与架构数字均为排版演示。', takeaway: '边界清楚，逐步交付', shortMetric: '演示 3层', tinyMetric: '演示3层',
    titles: { cover: '桌面工作台技术方案', context: '现状、约束与目标', relationship: '交互、服务与数据分层', process: '请求校验与执行路径', comparison: '部署方式与取舍', risks: '按影响与难度排序风险', observation: '请求耗时压测样例', trend: '分阶段验证里程碑', actions: '先完成高风险验证' },
    nodes: ['交互层', '服务层', '数据层', '授权边界', '运行监控', '交付检查'],
    items: ['界面收集输入并展示进度。', '服务校验请求后执行业务。', '数据层保存检查点与结果。', '限制文件范围和调用权限。', '记录错误来源便于排查。', '通过阶段验证再扩大部署。'],
    categories: ['首次请求', '缓存命中', '保存重开'],
    series: [{ name: '耗时毫秒（演示）', values: [420, 260, 310] }, { name: '目标毫秒（演示）', values: [500, 300, 350] }],
    axes: { x: '影响范围', y: '实施风险' },
  },
  'data-review': {
    subject: '经营指标复盘', summary: '指标与趋势数值仅作排版演示。', takeaway: '先核对口径，再解释变化', shortMetric: '指数 +8%', tinyMetric: '指数+8%',
    titles: { cover: '季度经营指标复盘', metrics: '收入、回款与交付指标', trend: '触达走势逐季回升', distribution: '各业务线贡献对照', comparison: '目标与实际差异', relationship: '指标之间的驱动关系', observation: '触达指数季度变化', actions: '把复盘结论变成行动', result: '下一阶段关注回款质量' },
    nodes: ['收入变化', '客户触达', '交付质量', '成本控制', '回款进度', '行动跟踪'],
    items: ['同一口径对比目标与实际。', '拆分主要产品和区域贡献。', '核对变化对应的时间范围。', '异常项补充来源与解释。', '回款风险匹配跟进负责人。', '每月复核已完成的动作。'],
    categories: ['一季度', '二季度', '三季度', '四季度'],
    series: [{ name: '触达指数（演示）', values: [62, 74, 69, 86] }, { name: '目标指数（演示）', values: [66, 72, 78, 82] }],
    axes: { x: '变化幅度', y: '业务影响' },
  },
  'strategy-planning': {
    subject: '年度战略规划', summary: '目标、情景与数据仅作排版演示。', takeaway: '先试点，再扩大投入', shortMetric: '示例 4季', tinyMetric: '4季样例',
    titles: { cover: '下一年度战略规划', context: '外部变化与内部目标', metrics: '战略目标与关键结果', relationship: '业务组合相互支撑', risks: '机会与风险情景', trend: '分阶段推进路线图', actions: '将战略重点转为行动', observation: '阶段目标达成趋势', comparison: '战略选项与资源取舍', result: '围绕验证结果调整节奏' },
    nodes: ['市场选择', '产品验证', '渠道拓展', '组织配套', '风险复核', '阶段复盘'],
    items: ['先验证重点客群的真实需求。', '为主力产品明确季度目标。', '渠道投入随验证结果调整。', '资源配置与交付能力匹配。', '重大风险设置触发条件。', '阶段复盘后再扩大投入。'],
    categories: ['第一阶段', '第二阶段', '第三阶段', '第四阶段'],
    series: [{ name: '目标进度（演示）', values: [22, 48, 73, 100] }, { name: '计划进度（演示）', values: [25, 50, 75, 100] }],
    axes: { x: '战略价值', y: '落地难度' },
  },
  'research-report': {
    subject: '用户协作流程调研', summary: '样本与发现均为排版演示。', takeaway: '结论只覆盖当前样本', shortMetric: '样本 32人', tinyMetric: '样本32人',
    titles: { cover: '用户协作流程调研', context: '研究问题与观察范围', breakdown: '从任务到交接的研究框架', process: '访谈与记录分析方法', metrics: '样本构成与任务完成率', comparison: '不同角色的使用差异', case: '典型任务场景观察', observation: '等待集中在资料交接', actions: '建议先验证交接改进', closing: '补充样本后再复核结论' },
    nodes: ['研究问题', '样本选择', '任务观察', '资料编码', '差异复核', '结论边界'],
    items: ['访谈对象按角色分层抽取。', '观察记录按统一表格整理。', '相似问题合并并保留原文。', '比较不同任务的等待环节。', '异常样本单独说明原因。', '扩大样本后再验证结论。'],
    categories: ['资料准备', '过程协作', '结果交接'],
    series: [{ name: '等待次数（演示）', values: [18, 27, 12] }, { name: '任务数量（演示）', values: [32, 32, 32] }],
    axes: { x: '发生频率', y: '任务影响' },
  },
  'business-pitch': {
    subject: '轻禾协作产品路演', summary: '虚构项目与数据仅作路演演示。', takeaway: '从高频小场景开始验证', shortMetric: '试点 27组', tinyMetric: '试点27组',
    titles: { cover: '轻禾协作产品路演', statement: '团队需要更顺畅的交付', context: '重复整理带来的时间成本', relationship: '客户、服务与收入闭环', metrics: '试点转化与留存样例', observation: '试点用户持续增加', comparison: '自建与协作交付取舍', team: '产品与交付协作分工', result: '融资用途聚焦产品验证', closing: '先完成小范围付费试点' },
    nodes: ['目标团队', '协作工具', '实施服务', '订阅收入', '客户反馈', '持续迭代'],
    items: ['聚焦项目协作频繁的小团队。', '用统一入口减少资料分散。', '按团队规模提供实施支持。', '订阅收入支持持续维护。', '跟踪试点后的真实使用情况。', '依据客户反馈安排迭代。'],
    categories: ['试点月', '第二月', '第三月'],
    series: [{ name: '活跃团队（演示）', values: [12, 19, 27] }, { name: '目标团队（演示）', values: [15, 22, 30] }],
    axes: { x: '客户价值', y: '获客难度' },
  },
  'investment-report': {
    subject: '示例制造企业投研', summary: '标的与回报均为情景演示，不构成预测。', takeaway: '按假设变化准备区间', shortMetric: '演示区间', tinyMetric: '情景演示',
    titles: { cover: '示例制造企业投研', context: '行业假设与研究边界', metrics: '收入、利润与现金流', observation: '订单与回款走势样例', trend: '产能利用逐季改善', comparison: '估值区间与可比口径', risks: '需求与成本风险情景', breakdown: '资产负债重点检查', result: '保留安全边际再决策', closing: '等待现金流证据确认' },
    nodes: ['收入假设', '毛利变化', '现金回收', '资本开支', '政策风险', '估值复核'],
    items: ['收入假设需由订单数据验证。', '成本变动关注原料和运费。', '回款进度影响现金流判断。', '扩产节奏与实际需求匹配。', '政策变化设置压力测试。', '估值结论保留上下行情景。'],
    categories: ['谨慎情景', '基准情景', '积极情景'],
    series: [{ name: '收入指数（演示）', values: [82, 100, 118] }, { name: '现金流指数（演示）', values: [76, 96, 112] }],
    axes: { x: '潜在收益', y: '风险程度' },
  },
  'brand-proposal': {
    subject: '青屿茶饮品牌提案', summary: '品牌方向、画面与文案均为演示素材。', takeaway: '清晰识别，克制表达', shortMetric: '触点 3类', tinyMetric: '3类触点',
    titles: { cover: '青屿茶饮品牌提案', statement: '让日常饮茶回到轻松本味', context: '年轻客群与门店体验', relationship: '品牌主张延伸到触点', image: '包装与视觉方向示意', comparison: '传统厚重与轻盈表达', trend: '从试点门店逐步铺开', team: '品牌、门店与供应协作', result: '先以小范围测试反馈' },
    nodes: ['品牌识别', '包装触点', '门店体验', '社交内容', '试点反馈', '规范维护'],
    items: ['以青绿色表达清新与安静。', '包装信息先满足快速识别。', '门店动线突出主打产品。', '社交内容保持真实轻松。', '试点门店收集顾客反馈。', '复核后再推广视觉规范。'],
    categories: ['识别设计', '门店应用', '传播内容'],
    series: [{ name: '触点样例（演示）', values: [3, 5, 4] }, { name: '复核目标（演示）', values: [4, 5, 5] }],
    axes: { x: '用户辨识', y: '实施成本' },
  },
  'company-story': {
    subject: '海风智造成长故事', summary: '公司名称与阶段成果均为故事演示。', takeaway: '每一步都为下一程积累', shortMetric: '示例 4程', tinyMetric: '4段示例',
    titles: { cover: '海风智造成长故事', statement: '从一线问题出发', context: '制造现场的协作难点', trend: '团队逐步扩展服务范围', process: '从单点试验到流程复用', team: '一线、产品与交付同行', image: '工作场景与团队实践', metrics: '服务覆盖阶段样例', relationship: '能力积累支撑新场景', closing: '继续围绕客户问题前进' },
    nodes: ['发现问题', '小组试验', '流程沉淀', '客户共创', '能力扩展', '阶段复盘'],
    items: ['记录现场反复发生的难题。', '选一个班组验证解决办法。', '把有效步骤沉淀为作业方法。', '与客户共同检查使用反馈。', '谨慎拓展到相邻生产场景。', '按阶段结果调整服务能力。'],
    categories: ['起步阶段', '验证阶段', '扩展阶段', '持续阶段'],
    series: [{ name: '服务场景（演示）', values: [1, 3, 6, 8] }, { name: '目标场景（演示）', values: [1, 3, 5, 8] }],
    axes: { x: '客户价值', y: '复用难度' },
  },
  'event-planning': {
    subject: '城市智造共创日', summary: '流程、时间与现场内容均为活动演示素材。', takeaway: '留出转场和交流时间', shortMetric: '示例 4场', tinyMetric: '4环演示',
    titles: { cover: '城市智造共创日', statement: '连接想法与现场实践', breakdown: '参会者的三条交流路径', trend: '活动筹备按周推进', team: '主持、场务与技术协作', image: '会场布置与展示区域', process: '从签到到成果回顾', risks: '现场风险与应急准备', metrics: '报名与到场样例', result: '活动后跟进共创事项' },
    nodes: ['嘉宾签到', '开场介绍', '主题分享', '分组共创', '成果交流', '会后跟进'],
    items: ['签到区核对来宾与资料。', '主持人说明议程和交流规则。', '分享围绕实际项目经验展开。', '分组记录问题和可行想法。', '预留提问及设备切换时间。', '整理共创结果并通知参与者。'],
    categories: ['报名阶段', '活动当天', '会后跟进'],
    series: [{ name: '参与人数（演示）', values: [48, 72, 30] }, { name: '安排容量（演示）', values: [60, 80, 36] }],
    axes: { x: '现场影响', y: '处理难度' },
  },
  'education-training': {
    subject: '从问题到可验证原型课程', summary: '课程练习、步骤与素材均为教学演示。', takeaway: '先说清问题，再检查结果', shortMetric: '练习 3步', tinyMetric: '练习3步',
    titles: { cover: '从问题到可验证原型', statement: '把想法变成可以检查的成果', breakdown: '课程的四个学习模块', relationship: '问题、原型与反馈相连', image: '练习成果与课堂过程示意', comparison: '模糊需求与明确任务', process: '从问题拆解到成果检查', metrics: '练习完成度样例', result: '用反馈安排下一轮练习', closing: '带着可验证结果结束课程' },
    nodes: ['识别问题', '拆分步骤', '制作原型', '邀请反馈', '检查结果', '复盘改进'],
    items: ['说明谁遇到什么具体困难。', '拆成可以逐项完成的小步骤。', '制作最小可操作原型。', '邀请同伴按任务实际尝试。', '对照验收条件检查结果。', '依据反馈修正并再次验证。'],
    categories: ['问题描述', '原型制作', '结果检查'],
    series: [{ name: '完成任务（演示）', values: [10, 18, 24] }, { name: '练习人数（演示）', values: [20, 20, 20] }],
    axes: { x: '学习价值', y: '练习难度' },
  },
}

function pathWithin(rootPath, candidate, label) {
  const rootValue = resolve(rootPath)
  const candidateValue = resolve(candidate)
  const remainder = relative(rootValue, candidateValue)
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`${label} 路径越界：${candidateValue}`)
  }
  return candidateValue
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`缺少${label}：${path}`)
    throw error
  }
}

function textLength(value) {
  return [...value].length
}

function boundCount(preset, field) {
  const pattern = new RegExp(`^${field}\\[(\\d+)\\]$`)
  const indices = preset.elements.flatMap((element) => element.kind === 'text' && typeof element.bind === 'string'
    ? [pattern.exec(element.bind)?.[1]]
    : []).filter((value) => value !== undefined).map(Number)
  return indices.length ? Math.max(...indices) + 1 : 0
}

function layoutImageCount(content) {
  return content.images?.length ? content.images.length : content.image ? 1 : 0
}

function sourceImageDimension(bytes) {
  if (bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('场景图片素材必须是 PNG。')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const plannedCopies = new Map()

async function sourceImageFor(reference) {
  const candidates = []
  if (isAbsolute(reference)) candidates.push(resolve(reference))
  else {
    candidates.push(resolve(scenarioDirectory, reference), resolve(repoRoot, reference))
    for (const root of allowedAssetRoots) candidates.push(resolve(root, reference), resolve(root, basename(reference)))
  }
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null)
    if (!info?.isFile()) continue
    const resolved = await realpath(candidate)
    let allowed = false
    for (const root of allowedAssetRoots) {
      const resolvedRoot = await realpath(root).catch(() => null)
      if (!resolvedRoot) continue
      const remainder = relative(resolvedRoot, resolved)
      if (remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder)) {
        allowed = true
        break
      }
    }
    if (!allowed) continue
    return resolved
  }
  throw new Error(`图片必须来自 tests/presets/assets 或 mona-pptx/assets/native：${reference}`)
}

async function fixtureAsset(reference) {
  const source = await sourceImageFor(reference)
  const previous = plannedCopies.get(source)
  if (previous) return previous
  const bytes = await readFile(source)
  const dimension = sourceImageDimension(bytes)
  const name = basename(source)
  const assetPath = `assets/${name}`
  const collision = [...plannedCopies.entries()].find(([existing]) => basename(existing) === name)
  if (collision && collision[0] !== source) throw new Error(`场景图片文件名冲突：${name}`)
  plannedCopies.set(source, { assetPath, source, dimension })
  return { assetPath, source, dimension }
}

async function materializeSignatureAssets(value) {
  if (Array.isArray(value)) return Promise.all(value.map(materializeSignatureAssets))
  if (!value || typeof value !== 'object') return value
  if (typeof value.assetPath === 'string') {
    const asset = await fixtureAsset(value.assetPath)
    if ((value.width !== undefined && value.width !== asset.dimension.width)
      || (value.height !== undefined && value.height !== asset.dimension.height)) {
      throw new Error(`特色页图片尺寸与真实 PNG 不一致：${value.assetPath}`)
    }
    return { ...value, assetPath: asset.assetPath, ...asset.dimension }
  }
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = await materializeSignatureAssets(item)
  }
  return result
}

function assertTextCapacity(preset, content) {
  const capacity = preset.capacity
  const layouts = preset.elements.filter((element) => element.kind === 'layout').map((element) => element.layout)
  const flexible = layouts.length > 0
  const titleRequired = flexible || preset.elements.some((element) => element.kind === 'text' && element.bind === 'title')
  const summaryVisible = flexible || preset.elements.some((element) => element.kind === 'text' && element.bind === 'summary')
  const takeawayVisible = flexible || preset.elements.some((element) => element.kind === 'text' && element.bind === 'takeaway')
  if (titleRequired && !content.title) throw new Error(`${preset.id} 缺少 title。`)
  for (const [key, value, max, visible] of [
    ['title', content.title, capacity.titleCharsMax, titleRequired],
    ['summary', content.summary, capacity.summaryCharsMax, summaryVisible],
    ['takeaway', content.takeaway, capacity.takeawayCharsMax, takeawayVisible],
  ]) {
    if (value === undefined) continue
    if (!visible) throw new Error(`${preset.id} 的 ${key} 没有可见落点。`)
    if (textLength(value) > max) throw new Error(`${preset.id} 的 ${key} 超出容量：${textLength(value)}/${max}。`)
  }
  for (const [field, max, textMax] of [
    ['items', capacity.itemsMax, capacity.itemCharsMax],
    ['nodes', capacity.nodesMax, capacity.nodeCharsMax],
  ]) {
    const values = content[field] ?? []
    if (values.length > max) throw new Error(`${preset.id} 的 ${field} 超出容量：${values.length}/${max}。`)
    if (values.some((value) => !value.trim() || textLength(value) > textMax)) {
      throw new Error(`${preset.id} 的 ${field} 包含空文本或超长项（上限 ${textMax} 字）。`)
    }
    const requiredCount = Math.max(capacity[`${field}Min`] ?? 0, boundCount(preset, field))
    if (values.length < requiredCount) throw new Error(`${preset.id} 的 ${field} 数量不足：${values.length}/${requiredCount}。`)
  }
}

function assertContentCapacity(preset, content) {
  const capacity = preset.capacity
  const layouts = preset.elements.filter((element) => element.kind === 'layout').map((element) => element.layout)
  const matrix = layouts.includes('matrix-2x2') || preset.family === 'matrix'
  if (content.relation !== undefined && content.relation !== preset.relation) {
    throw new Error(`${preset.id} 关系不匹配：${content.relation}/${preset.relation ?? '未声明'}。`)
  }
  if (matrix) {
    if (!content.axes || !['x', 'y'].every((axis) => typeof content.axes[axis] === 'string'
      && textLength(content.axes[axis]) >= 1 && textLength(content.axes[axis]) <= 6)) {
      throw new Error(`${preset.id} 必须提供 1–6 字的 axes.x / axes.y。`)
    }
    if (content.nodes?.length !== 4 || content.items?.length !== 4) {
      throw new Error(`${preset.id} 的矩阵必须保留四个节点和四条说明。`)
    }
  } else if (content.axes !== undefined) {
    throw new Error(`${preset.id} 不是矩阵页，不能声明 axes。`)
  }
  for (const layout of layouts) {
    if (['parallel-columns', 'parallel-grid', 'timeline', 'matrix-2x2', 'comparison-split', 'process-steps', 'team-grid'].includes(layout)
      && (content.items?.length ?? 0) !== (content.nodes?.length ?? 0)) {
      throw new Error(`${preset.id} 的 ${layout} 必须逐项对应 nodes 与 items。`)
    }
    if (layout === 'hierarchy-branch' && content.items?.length
      && content.items.length !== (content.nodes?.length ?? 0) - 1) {
      throw new Error(`${preset.id} 的 hierarchy-branch 每条说明必须对应一个子节点。`)
    }
    if (layout === 'chart-evidence' && content.nodes?.length
      && content.nodes.length !== (content.items?.length ?? 0)) {
      throw new Error(`${preset.id} 的证据节点与说明数量不一致。`)
    }
  }
  if (preset.elements.some((element) => element.kind === 'diagram' && element.layout === 'vertical')
    && (content.items?.length ?? 0) !== (content.nodes?.length ?? 0)) {
    throw new Error(`${preset.id} 的流程解释必须与节点数一致。`)
  }
  if (content.chart) {
    if (content.chart.categories.length > capacity.categoriesMax || content.chart.series.length > capacity.seriesMax) {
      throw new Error(`${preset.id} 的图表分类或系列超出静态容量。`)
    }
    if (content.chart.categories.some((item) => textLength(item) > 12)) throw new Error(`${preset.id} 的图表分类超过 12 字。`)
    const mismatched = content.chart.series.find((series) => series.values.length !== content.chart.categories.length)
    if (mismatched) throw new Error(`${preset.id} 的图表 series/categories 数量不匹配。`)
  }
  if ((preset.capacity.imageRequired || preset.elements.some((element) => element.kind === 'image'))
    && !content.image?.assetPath && !content.image?.dataUrl) {
    throw new Error(`${preset.id} 缺少真实图片素材。`)
  }
  if (content.images && content.images.length > (capacity.imagesMax ?? 0)) {
    throw new Error(`${preset.id} 的图片数超出容量。`)
  }
  if ((content.images?.length ?? 0) < (capacity.imagesMin ?? 0)) {
    throw new Error(`${preset.id} 的图片数未满足最低容量。`)
  }
  const imageCount = layoutImageCount(content)
  const arraysLength = Math.max(content.items?.length ?? 0, content.nodes?.length ?? 0)
  for (const element of preset.elements.filter((item) => item.kind === 'layout')) {
    if (element.layout === 'gallery') {
      const min = Math.max(2, capacity.imagesMin ?? 0, element.minImages ?? 0,
        element.count ?? 0, element.minItems ?? 0, element.minNodes ?? 0)
      const max = Math.min(4, capacity.imagesMax ?? 4, element.maxImages ?? 4,
        element.count ?? 4, element.maxItems ?? 4, element.maxNodes ?? 4)
      const observed = Math.max(arraysLength, imageCount)
      const count = element.count ?? observed
      if (count < min || count > max || observed > count) {
        throw new Error(`${preset.id} 的 gallery 页槽位数超出声明范围：${observed}/${min}-${max}。`)
      }
      if (imageCount !== count) {
        throw new Error(`${preset.id} 的 gallery 每个节点槽位都需要一张真实图片：${imageCount}/${count}。`)
      }
    }
    if (element.layout === 'team-grid') {
      const min = element.count ?? element.minItems ?? element.minNodes ?? 2
      const max = element.count ?? element.maxItems ?? element.maxNodes ?? 4
      const observed = Math.max(arraysLength, imageCount)
      const count = element.count ?? observed
      if (count < min || count > max || observed > count) {
        throw new Error(`${preset.id} 的 team-grid 成员数超出声明范围：${observed}/${min}-${max}。`)
      }
      if (imageCount > (element.maxImages ?? capacity.imagesMax ?? 0)) {
        throw new Error(`${preset.id} 的 team-grid 图片数超出每成员图片容量。`)
      }
      // Team portraits are optional; when supplied, the renderer uses them by index.
    }
    if (element.layout === 'cover-split') {
      const min = Math.max(capacity.imagesMin ?? 0, element.count ?? 0, element.minImages ?? 1)
      const max = Math.min(capacity.imagesMax ?? 1, element.count ?? 1, element.maxImages ?? 1)
      if (imageCount < min || imageCount > max) {
        throw new Error(`${preset.id} 的 cover-split 需要 ${min}-${max} 张真实图片，收到 ${imageCount} 张。`)
      }
    }
  }
  assertTextCapacity(preset, content)
}

function selectCount(preset, field, desired, requiredSlots = 0) {
  return Math.max(preset.capacity[`${field}Min`] ?? 0, requiredSlots,
    Math.min(preset.capacity[`${field}Max`] ?? 0, desired))
}

function sampleValues(values, count, offset = 0) {
  return Array.from({ length: count }, (_, index) => values[(offset + index) % values.length])
}

function pairedLayout(preset) {
  const layouts = preset.elements.filter((element) => element.kind === 'layout').map((element) => element.layout)
  return layouts.some((layout) => ['parallel-columns', 'parallel-grid', 'timeline', 'matrix-2x2', 'comparison-split', 'process-steps', 'team-grid', 'chart-evidence'].includes(layout))
    || preset.elements.some((element) => element.kind === 'diagram' && element.layout === 'vertical')
    || (preset.capacity.nodesMax > 0 && preset.capacity.nodesMax === preset.capacity.itemsMax
      && ['parallel', 'sequence', 'matrix'].includes(preset.relation))
}

function isHierarchyBranch(preset) {
  const layouts = preset.elements.filter((element) => element.kind === 'layout').map((element) => element.layout)
  return layouts.includes('hierarchy-branch') || (preset.relation === 'hierarchy'
    && preset.capacity.nodesMax === preset.capacity.itemsMax + 1)
}

function pageTitle(copy, preset, signaturePage, role, titleMax) {
  const values = [copy.titles?.[role], copy.titles?.[preset.family], signaturePage?.label, copy.subject]
  const selected = values.find((value) => typeof value === 'string' && textLength(value) <= titleMax)
  if (!selected) throw new Error(`${preset.id} 找不到不超容量的场景标题。`)
  return selected
}

function demoChart(copy, preset) {
  const categoryCount = selectCount(preset, 'categories', Math.min(3, copy.categories.length))
  const seriesCount = Math.max(1, Math.min(preset.capacity.seriesMax, copy.series.length, 2))
  if (categoryCount < 1 || seriesCount < 1) throw new Error(`${preset.id} 图表容量必须至少有一个分类和系列。`)
  return {
    kind: 'bar',
    categories: copy.categories.slice(0, categoryCount),
    series: copy.series.slice(0, seriesCount).map((series) => ({
      name: series.name,
      values: series.values.slice(0, categoryCount),
    })),
    legendPos: seriesCount > 1 ? 'b' : 'none',
    gridlines: true,
    dataLabels: true,
    valAxisTitle: '演示值',
  }
}

async function genericContent(scenario, preset, signaturePage, pageIndex) {
  const copy = scenarioCopy[scenario.id]
  if (!copy) throw new Error(`缺少 ${scenario.id} 的中文示例文案。`)
  const capacity = preset.capacity
  const layouts = preset.elements.filter((element) => element.kind === 'layout').map((element) => element.layout)
  const flexible = layouts.length > 0
  const binds = preset.elements.filter((element) => element.kind === 'text').map((element) => element.bind)
  const hasImage = preset.capacity.imageRequired || preset.elements.some((element) => element.kind === 'image')
  const imagesMin = capacity.imagesMin ?? 0
  const hasChart = preset.capacity.seriesMax > 0 || preset.elements.some((element) => element.kind === 'chart')
  const hasNodes = capacity.nodesMax > 0 && (flexible || binds.some((bind) => bind.startsWith('nodes['))
    || preset.elements.some((element) => element.kind === 'smartart' || element.kind === 'diagram'))
  const hasItems = capacity.itemsMax > 0 && (flexible || binds.some((bind) => bind.startsWith('items['))
    || preset.elements.some((element) => element.kind === 'diagram' && element.layout === 'vertical'))
  const nodeSlots = boundCount(preset, 'nodes')
  const itemSlots = boundCount(preset, 'items')
  const defaultCount = ({
    'matrix-2x2': 4,
    'parallel-grid': capacity.nodesMax,
    'team-grid': 4,
    'gallery': 2,
    'timeline': 4,
    'process-steps': 4,
    'process-map': 4,
    'comparison-split': 2,
  })[layouts.find((layout) => /matrix-2x2|parallel-grid|team-grid|gallery|timeline|process-steps|comparison-split/.test(layout))]
    ?? (preset.family === 'matrix' ? 4 : preset.family === 'gallery' ? 2 : 3)
  let nodeCount = hasNodes ? selectCount(preset, 'nodes', defaultCount, nodeSlots) : 0
  let itemCount = hasItems ? selectCount(preset, 'items', defaultCount, itemSlots) : 0
  if (hasNodes && hasItems && pairedLayout(preset)) {
    const commonMax = Math.min(capacity.nodesMax, capacity.itemsMax)
    const commonMin = Math.max(capacity.nodesMin ?? 0, capacity.itemsMin ?? 0, nodeSlots, itemSlots)
    const commonCount = Math.max(commonMin, Math.min(commonMax, defaultCount))
    nodeCount = commonCount
    itemCount = commonCount
  } else if (hasNodes && hasItems && isHierarchyBranch(preset)) {
    const minNodes = Math.max(capacity.nodesMin ?? 0, nodeSlots, (capacity.itemsMin ?? 0) + 1, itemSlots + 1)
    const maxNodes = Math.min(capacity.nodesMax, capacity.itemsMax + 1)
    nodeCount = Math.max(minNodes, Math.min(maxNodes, defaultCount))
    itemCount = nodeCount - 1
  }
  if (nodeCount > copy.nodes.length || itemCount > copy.items.length) {
    throw new Error(`${scenario.id}/${preset.id} 的场景词库不足以填满页面容量。`)
  }

  const imageSummaries = {
    'brand-proposal': '品牌与配图均为演示素材。',
    'event-planning': '活动与配图均为演示素材。',
    'education-training': '课程与配图均为演示素材。',
  }
  const summary = hasImage || imagesMin > 0
    ? imageSummaries[scenario.id] ?? '样例数据；配图为历史界面演示素材。'
    : copy.summary
  const content = {
    title: pageTitle(copy, preset, signaturePage, signaturePage?.role, capacity.titleCharsMax),
    ...(flexible || binds.includes('summary') ? { summary } : {}),
    ...(capacity.takeawayCharsMax > 0 && (flexible || binds.includes('takeaway'))
      ? { takeaway: capacity.takeawayCharsMax <= 5 ? copy.tinyMetric
        : capacity.takeawayCharsMax <= 8 ? copy.shortMetric : copy.takeaway }
      : {}),
    ...(hasItems ? { items: sampleValues(copy.items, itemCount, pageIndex % 2) } : {}),
    ...(hasNodes ? { nodes: sampleValues(copy.nodes, nodeCount, pageIndex % 2) } : {}),
    ...(preset.relation ? { relation: preset.relation } : {}),
    ...(signaturePage?.role ? { role: signaturePage.role } : {}),
    scenario: scenario.id,
    theme: scenario.defaultTheme,
    ...(layouts.includes('matrix-2x2') || preset.family === 'matrix' ? { axes: copy.axes } : {}),
    ...(hasChart ? { chart: demoChart(copy, preset) } : {}),
  }
  if (hasImage) {
    const asset = await fixtureAsset('product-workspace.png')
    content.image = { assetPath: asset.assetPath, ...asset.dimension, fit: 'contain' }
  }
  if (imagesMin > 0) {
    const gallery = preset.elements.find((element) => element.kind === 'layout' && element.layout === 'gallery')
    const galleryMin = gallery
      ? Math.max(2, imagesMin, gallery.minImages ?? 0, gallery.minItems ?? 0, gallery.minNodes ?? 0)
      : imagesMin
    const galleryMax = gallery
      ? Math.min(4, capacity.imagesMax ?? 4, gallery.maxImages ?? 4, gallery.maxItems ?? 4, gallery.maxNodes ?? 4)
      : capacity.imagesMax ?? imagesMin
    const observedSlots = Math.max(nodeCount, itemCount)
    const imageCount = gallery
      ? gallery.count ?? Math.max(observedSlots, galleryMin)
      : Math.max(imagesMin, Math.min(galleryMax, 2))
    if (imageCount < galleryMin || imageCount > galleryMax || observedSlots > imageCount) {
      throw new Error(`${scenario.id}/${preset.id} 的图片槽位容量不匹配：nodes/items=${observedSlots}，images=${imageCount}，上限=${galleryMax}。`)
    }
    const refs = ['product-workspace.png', 'brand-square.png']
    if (imageCount > refs.length) throw new Error(`${scenario.id}/${preset.id} 需要 ${imageCount} 张不同图片，但只有 ${refs.length} 张允许素材。`)
    content.images = []
    for (const ref of refs.slice(0, imageCount)) {
      const asset = await fixtureAsset(ref)
      content.images.push({ assetPath: asset.assetPath, ...asset.dimension, fit: 'contain' })
    }
  }
  return content
}

function appendDemoNotice(content, scenario, preset) {
  const needsNotice = ['brand-proposal', 'event-planning', 'education-training'].includes(scenario.id)
    || content.image?.assetPath
    || content.images?.length
  if (!needsNotice) return
  const summary = content.summary ?? ''
  if (/演示素材|演示内容/u.test(summary)) return
  const imagePaths = [content.image?.assetPath, ...(content.images ?? []).map((image) => image.assetPath)]
  const hasHistoricalProductScreenshot = imagePaths.some((assetPath) => typeof assetPath === 'string'
    && assetPath.includes('product-workspace'))
  const note = content.image?.assetPath || content.images?.length
    ? hasHistoricalProductScreenshot ? '配图为历史界面演示素材。' : '配图为演示素材。'
    : '本页为演示素材。'
  const updated = summary ? `${summary}${note}` : note
  if (textLength(updated) > preset.capacity.summaryCharsMax) {
    throw new Error(`${scenario.id}/${preset.id} 的演示素材说明会超过 summary 容量；需改写签名文案。`)
  }
  content.summary = updated
}

function validateContent(preset, content, scenario) {
  const allowed = new Set(['title', 'summary', 'takeaway', 'items', 'nodes', 'chart', 'image', 'images', 'facts', 'role', 'relation', 'axes', 'theme', 'scenario', 'accentColor'])
  for (const key of Object.keys(content)) if (!allowed.has(key)) throw new Error(`${scenario.id}/${preset.id} 有不支持的内容字段：${key}`)
  if (content.scenario !== scenario.id) throw new Error(`${preset.id} 缺少准确的 scenario 标识。`)
  if (content.theme !== scenario.defaultTheme) throw new Error(`${scenario.id}/${preset.id} 必须沿用场景默认主题。`)
  if (content.relation && content.relation !== preset.relation) throw new Error(`${scenario.id}/${preset.id} 的关系与预设不一致。`)
  if (content.chart) {
    if (!Array.isArray(content.chart.categories) || !content.chart.categories.length
      || !Array.isArray(content.chart.series) || !content.chart.series.length) {
      throw new Error(`${scenario.id}/${preset.id} 的 chart 必须包含分类与系列。`)
    }
    if (content.chart.series.some((series) => series.values.length !== content.chart.categories.length
      || series.values.some((value) => !Number.isFinite(value)))) {
      throw new Error(`${scenario.id}/${preset.id} 的 chart series/categories 数量或数值无效。`)
    }
  }
  appendDemoNotice(content, scenario, preset)
  assertContentCapacity(preset, content)
}

async function main() {
  const scenariosFile = await readJson(scenarioCatalogPath, '场景目录')
  const signaturesFile = await readJson(signaturesPath, '场景特色页内容')
  const semantics = await readJson(legacySemanticsPath, '旧版预设关系')
  if (!Array.isArray(scenariosFile?.scenarios) || scenariosFile.scenarios.length !== 12) {
    throw new Error('scenarios.json 必须包含 12 个场景。')
  }
  const definitionFiles = await Promise.all(catalogPaths.map((path) => readJson(path, '预设定义')))
  if (definitionFiles.some((file) => !Array.isArray(file?.presets))) throw new Error('预设定义文件必须包含 presets 数组。')
  const presets = definitionFiles.flatMap((file) => file.presets).map((preset) => ({
    ...preset,
    ...(semantics[preset.id] ?? {}),
  }))
  const presetById = new Map()
  for (const preset of presets) {
    if (!preset || typeof preset.id !== 'string' || presetById.has(preset.id)) throw new Error(`预设 ID 缺失或重复：${preset?.id}`)
    presetById.set(preset.id, preset)
  }

  const ownerByPreset = new Map()
  const scenarioById = new Map()
  for (const scenario of scenariosFile.scenarios) {
    if (!scenario || typeof scenario.id !== 'string' || !Array.isArray(scenario.templateIds)
      || scenario.templateIds.length < 8 || scenario.templateIds.length > 12) {
      throw new Error('每个场景必须声明 8–12 个 templateIds。')
    }
    if (scenarioById.has(scenario.id)) throw new Error(`场景 ID 重复：${scenario.id}`)
    scenarioById.set(scenario.id, scenario)
    if (!Array.isArray(scenario.signaturePages) || scenario.templateIds.length !== scenario.signaturePages.length) {
      throw new Error(`${scenario.id} 的 signaturePages 必须与 templateIds 一一对应。`)
    }
    for (const id of scenario.templateIds) {
      if (scenario.signaturePages.filter((page) => page.preferredPresetId === id).length !== 1) {
        throw new Error(`${scenario.id} 缺少唯一对应 ${id} 的 signature 元数据。`)
      }
    }
    for (const id of scenario.templateIds) {
      if (!presetById.has(id)) throw new Error(`${scenario.id} 引用了不存在的预设：${id}`)
      ownerByPreset.set(id, [...(ownerByPreset.get(id) ?? []), scenario.id])
    }
  }
const unassignedTemplateIds = [...presetById.keys()].filter((id) => !ownerByPreset.has(id))
if (unassignedTemplateIds.length) {
  throw new Error(`以下预设尚未分配到场景：${unassignedTemplateIds.join(', ')}`)
}

  const signaturePages = (Array.isArray(signaturesFile?.decks) ? signaturesFile.decks : [])
    .flatMap((deck) => Array.isArray(deck.pages) ? deck.pages : [])
  if (signaturePages.length !== 12) throw new Error('signatures.json 必须恰好包含 12 个场景特色页。')
  const signaturesByScenario = new Map()
  for (const page of signaturePages) {
    if (!page || typeof page.presetId !== 'string' || !page.content || typeof page.content !== 'object') {
      throw new Error('signatures.json 包含无效特色页。')
    }
    const owners = ownerByPreset.get(page.presetId) ?? []
    if (owners.length !== 1) throw new Error(`特色页 ${page.presetId} 必须只属于一个场景。`)
    if (signaturesByScenario.has(owners[0])) throw new Error(`${owners[0]} 包含多个特色页。`)
    signaturesByScenario.set(owners[0], page)
  }
  for (const scenario of scenariosFile.scenarios) {
    if (!signaturesByScenario.has(scenario.id)) throw new Error(`${scenario.id} 缺少 signature 页面。`)
  }

  const decks = []
  for (const scenario of scenariosFile.scenarios) {
    const signature = signaturesByScenario.get(scenario.id)
    const pages = []
    for (const [pageIndex, presetId] of scenario.templateIds.entries()) {
      const preset = presetById.get(presetId)
      const signatureMeta = scenario.signaturePages.find((page) => page.preferredPresetId === presetId)
      if (!signatureMeta) throw new Error(`${scenario.id} 第 ${pageIndex + 1} 页缺少 ${presetId} 的 signature 元数据。`)
      if (signatureMeta.relation !== (preset.relation ?? 'none')) {
        throw new Error(`${scenario.id}/${presetId} 的 signature relation 与预设关系不一致：${signatureMeta.relation}/${preset.relation ?? 'none'}。`)
      }
      let content
      if (signature.presetId === presetId) {
        content = await materializeSignatureAssets(structuredClone(signature.content))
        content.scenario = scenario.id
        content.theme = scenario.defaultTheme
        if (content.relation === undefined && preset.relation) content.relation = preset.relation
        if (content.role === undefined && signatureMeta.role) content.role = signatureMeta.role
      } else {
        content = await genericContent(scenario, preset, signatureMeta, pageIndex)
      }
      validateContent(preset, content, scenario)
      pages.push({
        name: signature.presetId === presetId ? signature.name ?? presetId : presetId,
        presetId,
        content,
      })
    }
    decks.push({ name: scenario.id, pages })
  }

  await mkdir(resolve(scenarioDirectory, 'assets'), { recursive: true })
  for (const { assetPath, source } of plannedCopies.values()) {
    const destination = pathWithin(scenarioDirectory, resolve(scenarioDirectory, assetPath), '场景图片')
    await copyFile(source, destination)
  }
  const fixture = {
    schemaVersion: 1,
    note: '12 个原生 PPT 场景的代表页；示例文字、数值与产品界面素材仅用于排版验收。',
    decks,
  }
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({
    output: fixturePath,
    scenarios: decks.length,
    pages: decks.map((deck) => ({ name: deck.name, count: deck.pages.length })),
    copiedImages: plannedCopies.size,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
