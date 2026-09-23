import { COMPOSE_FIELDS } from './slides-layout'
import { PRESETS } from './slides-presets'
import { DESIGN_CATALOG } from './slides-design'
import { replaceColorsCapability } from './slides-colors'
import { designCapability, pathCapability, richTextFields } from './slides-design-schema'

export interface SlidesCapability {
  op: string
  payloadSchema: Record<string, unknown>
  description: string
  supportedElementTypes?: readonly string[]
}

export interface SlidesCapabilitiesResult {
  mode: 'capabilities'
  documentType: 'slides'
  designs?: Array<{ id: string; label: string; use: string }>
  operations: Array<Pick<SlidesCapability, 'op' | 'description'> & { payloadSchema?: Record<string, unknown> }>
  availableOperations: string[]
  unsupportedOperations: string[]
  inapplicableOperations: string[]
  nextOperations: string[]
  note: string
}

const slideId = { type: 'string', description: '稳定幻灯片 ID' }
const elementId = { type: 'string', description: '稳定元素 ID' }
const geometry = {
  x: { type: 'number', description: '预览像素，左上角 X' },
  y: { type: 'number', description: '预览像素，左上角 Y' },
  width: { type: 'number', exclusiveMinimum: 0, description: '预览像素，宽度' },
  height: { type: 'number', exclusiveMinimum: 0, description: '预览像素，高度' },
}
const font = {
  type: 'object',
  properties: {
    fontFamily: { type: 'string' },
    fontSize: { type: 'number', exclusiveMinimum: 0 },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    underline: { type: 'boolean' },
    strike: { type: 'boolean' },
    color: { type: 'string', description: '#RRGGBB' },
  },
}
const addFont = {
  type: 'object',
  properties: {
    letterSpacing: { type: 'number', description: '字距pt' }, baseline: { type: 'number', description: '基线偏移百分比' }, underline: { type: 'boolean' },
    fontFamily: { type: 'string' },
    fontSize: { type: 'number', exclusiveMinimum: 0 },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    color: { type: 'string', description: '#RRGGBB' },
  },
}

const chartStyle = {
  type: 'object', additionalProperties: false,
  properties: {
    textColor: { type: 'string', description: '#RRGGBB' },
    titleColor: { type: 'string' }, axisLabelColor: { type: 'string' },
    axisTitleColor: { type: 'string' }, legendColor: { type: 'string' },
    dataLabelColor: { type: 'string' },
    seriesColors: { type: 'array', minItems: 1, items: { type: 'string' }, description: '按系列顺序的 #RRGGBB 调色板' },
    gridColor: { type: 'string' }, axisLineColor: { type: 'string' },
    axisLabelFontSize: { type: 'number', exclusiveMinimum: 0, description: '坐标轴标签字号，单位 pt' },
  },
}
const chartFields = {
  kind: { type: 'string', enum: ['bar', 'line', 'area', 'pie', 'doughnut'] },
  title: { type: 'string' },
  categories: { type: 'array', minItems: 1, items: { type: 'string' } },
  series: { type: 'array', minItems: 1, items: {
    type: 'object', required: ['name', 'values'], additionalProperties: false,
    properties: { name: { type: 'string' }, values: { type: 'array', minItems: 1, items: { type: 'number' } } },
  } },
  legendPos: { type: 'string', enum: ['none', 'b', 't', 'l', 'r'] },
  gridlines: { type: 'boolean' }, dataLabels: { type: 'boolean' },
  catAxisTitle: { type: 'string' }, valAxisTitle: { type: 'string' },
  gapWidthPct: { type: 'number', description: '柱/条间距百分比（引擎默认 150）' },
  style: chartStyle,
}

const directCapabilities: SlidesCapability[] = [
  replaceColorsCapability,
  designCapability,
  pathCapability,
  {
    op: 'slide_add_chart',
    payloadSchema: {
      type: 'object', additionalProperties: false,
      required: ['slideId', 'x', 'y', 'width', 'height', 'kind', 'categories', 'series'],
      properties: {
        slideId, ...geometry,
        ...chartFields,
      },
    },
    description: '用预览像素位置和分类/数值直接创建可编辑原生图表，无需换算 EMU。用于数值比较，勿用字符条或空格模拟图表。可选 style 在创建时原子应用系列色、文字和坐标轴样式；失败整批回滚，无需先取得图表 ID 再调色。',
    supportedElementTypes: ['chart'],
  },
  {
    op: 'slide_set_text',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'elementId'],
      properties: { slideId, elementId, text: { type: 'string' }, paragraphs: richTextFields.paragraphs },
      oneOf: [{ required: ['text'] }, { required: ['paragraphs'] }],
    },
    description: '替换文本框或形状中的文本。',
    supportedElementTypes: ['shape', 'text'],
  },
  {
    op: 'slide_set_font',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'elementId', 'font'],
      properties: { slideId, elementId, font },
    },
    description: '设置文本、形状或表格的字体；图表仅支持字体颜色。',
    supportedElementTypes: ['shape', 'text', 'table', 'chart'],
  },
  {
    op: 'slide_set_chart_style',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'elementId', 'style'],
      properties: {
        slideId,
        elementId,
        style: chartStyle,
      },
    },
    description: '设置原生图表的文字颜色和系列填充色；文字颜色字段以图表读取结果的 supportedTextStyleFields 为准，seriesColors 按系列顺序写入各系列填充。',
    supportedElementTypes: ['chart'],
  },
  {
    op: 'slide_set_geometry',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'elementId', 'x', 'y', 'width', 'height'],
      properties: { slideId, elementId, ...geometry },
    },
    description: '移动或缩放元素，几何字段使用当前预览像素。',
    supportedElementTypes: ['shape', 'text', 'picture', 'table', 'chart', 'group', 'placeholder-chip'],
  },
  {
    op: 'slide_set_fill',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'elementId', 'color'],
      properties: {
        slideId,
        elementId,
        color: { type: ['string', 'null'], description: '颜色或 null 表示无填充' },
      },
    },
    description: '设置文本框或形状的纯色填充。',
    supportedElementTypes: ['shape', 'text'],
  },
  {
    op: 'slide_set_stroke',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'elementId', 'color'],
      properties: {
        slideId,
        elementId,
        color: { type: ['string', 'null'], description: '颜色或 null 表示无描边' },
        widthPt: { type: 'number', exclusiveMinimum: 0 },
      },
    },
    description: '设置文本框、形状或图片的描边。',
    supportedElementTypes: ['shape', 'text', 'picture'],
  },
  {
    op: 'slide_delete_element',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'elementId'],
      properties: { slideId, elementId },
    },
    description: '删除指定元素。',
    supportedElementTypes: ['shape', 'text', 'picture', 'table', 'chart', 'group', 'placeholder-chip'],
  },
  {
    op: 'slide_add_text',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'x', 'y', 'width', 'height'],
      oneOf: [{ required: ['text'] }, { required: ['paragraphs'] }],
      properties: {
        slideId,
        ...geometry,
        text: { type: 'string' },
        ...richTextFields,
        font: addFont,
        align: { enum: ['left', 'center', 'right', 'justify'] },
        fillColor: { type: 'string' },
        strokeColor: { type: ['string', 'null'] },
        strokeWidthPt: { type: 'number', exclusiveMinimum: 0 },
      },
    },
    description: '插入可编辑文本框，几何字段使用当前预览像素。',
    supportedElementTypes: ['text'],
  },
  {
    op: 'slide_add_shape',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'x', 'y', 'width', 'height'],
      properties: {
        slideId,
        ...geometry,
        shape: { type: 'string', default: 'rect' },
        text: { type: 'string' },
        ...richTextFields,
        font: addFont,
        align: { enum: ['left', 'center', 'right', 'justify'] },
        fillColor: { type: 'string' },
        strokeColor: { type: ['string', 'null'] },
        strokeWidthPt: { type: 'number', exclusiveMinimum: 0 },
      },
    },
    description: '插入可编辑基础形状，几何字段使用当前预览像素。',
    supportedElementTypes: ['shape'],
  },
  {
    op: 'slide_add_image',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'x', 'y', 'width', 'height'],
      oneOf: [{ required: ['assetPath'] }, { required: ['dataUrl'] }],
      properties: {
        slideId,
        ...geometry,
        dataUrl: { type: 'string', description: '受支持图片格式的 base64 data URL' },
        assetPath: { type: 'string', description: '优先使用当前工作区的图片路径，由 office 工具读取并转为 dataUrl' },
      },
    },
    description: '插入可移动、可缩放的图片。',
    supportedElementTypes: ['picture'],
  },
  {
    op: 'slide_add_svg',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'svg', 'x', 'y', 'width', 'height'],
      properties: {
        slideId,
        svg: { type: 'string', description: 'SVG 图片字符串；作为整体图片保留，不拆解为路径。' },
        ...geometry,
      },
    },
    description: '插入作为整体图片的 SVG，可移动和缩放，不拆解为路径。',
    supportedElementTypes: ['picture'],
  },
  {
    op: 'slide_add',
    payloadSchema: {
      type: 'object',
      required: ['slideId'],
      properties: { slideId },
    },
    description: '在指定幻灯片后插入空白幻灯片。',
  },
  {
    op: 'slide_duplicate',
    payloadSchema: {
      type: 'object',
      required: ['slideId'],
      properties: { slideId },
    },
    description: '复制指定幻灯片。',
  },
  {
    op: 'slide_delete',
    payloadSchema: {
      type: 'object',
      required: ['slideId'],
      properties: { slideId },
    },
    description: '删除指定幻灯片。',
  },
  {
    op: 'slide_move',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'toIndex'],
      properties: { slideId, toIndex: { type: 'integer', minimum: 0 } },
    },
    description: '将指定幻灯片移动到 0 基目标位置。',
  },
  {
    op: 'slide_apply_txn',
    payloadSchema: {
      type: 'object',
      required: ['ops'],
      properties: {
        ops: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          description: '已注册且受 Editor 支持的 GenOffice 结构化操作。',
        },
      },
    },
    description: '原子应用已实现的 GenOffice 结构化操作；不要猜测未列入 Editor 的注册表操作。',
  },
  {
    op: 'slide_compose',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'columns', 'rows', 'items'],
      properties: {
        slideId,
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 },
        columns: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 } },
        rows: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 } },
        gap: { type: 'number', minimum: 0, default: 24 },
        items: {
          type: 'array',
          description: '按顺序叠放的 grid item；type 为 text、shape、image、svg 或 chart。chart 使用原生数据及可选 style。',
          items: {
            type: 'object',
            required: ['type', 'column', 'row'],
            properties: {
              type: { enum: ['text', 'shape', 'image', 'svg', 'chart'] },
              column: { type: 'integer', minimum: 0 },
              row: { type: 'integer', minimum: 0 },
              columnSpan: { type: 'integer', minimum: 1 },
              rowSpan: { type: 'integer', minimum: 1 },
              ...chartFields,
              inset: { type: 'number', minimum: 0 },
              text: { type: 'string' },
              ...richTextFields,
              font: addFont,
              align: { enum: ['left', 'center', 'right', 'justify'] },
              shape: { type: 'string' },
              fillColor: { type: 'string' },
              strokeColor: { type: ['string', 'null'] },
              strokeWidthPt: { type: 'number', exclusiveMinimum: 0 },
              dataUrl: { type: 'string' },
              assetPath: { type: 'string', description: 'image 素材在当前工作区的路径，由 office 工具读取' },
              svg: { type: 'string' },
            },
          },
        },
      },
    },
    description: `在指定幻灯片内按网格插入可编辑内容；支持字段：${Object.keys(COMPOSE_FIELDS).join(', ')}。`,
  },
  {
    op: 'slide_add_preset',
    payloadSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slideId'],
      properties: {
        slideId,
        presetId: { type: 'string', enum: ['auto','auto-content',...PRESETS.map((preset) => preset.id)], description: '默认 auto 选择适配预设；无匹配则解释原因，不隐式降级。可直接使用原生操作；auto-content 仅用于主动选择的基础草稿。' },
        contentRef: { type: 'string', description: '查询候选返回的只读内容引用，与 content 二选一；跨候选复用同一内容，不能为了套模板删事实' },
        content: {
          type: 'object',
          additionalProperties: false,
          description: '本页真实内容；几何、字号、颜色和对象由预设生成，不要重复提供坐标或样式。',
          properties: {
            title: { type: 'string' },
            theme: {type:'string',enum:['light-editorial','dark-product'],description:'整稿视觉方向；首个成功页面后自动继承'},
            accentColor: {type:'string',description:'用户品牌强调色 #RRGGBB；同一编辑器会话后续页面继承'},
            role: { type: 'string', description: '页面用途，取自 presetRoles 目录；用于软排序' },
            relation: { type: 'string', enum: ['none','parallel','sequence','hierarchy','matrix','cycle','network'], description: '本页真实关系；选页和写入都必须匹配' },
            axes: {type:'object',description:'矩阵真实维度，必填 x/y 各 1–6 字；不得套用模板的示例维度',required:['x','y'],properties:{x:{type:'string'},y:{type:'string'}}},
            facts: { type: 'array', description: '事实只写一次，程序将未展示的必含事实追加到正文；有结构节点的页面保留原配对，不得删除事实', items: {
              type:'object',additionalProperties:false,required:['id','text'],properties:{id:{type:'string'},text:{type:'string'},required:{type:'boolean'}},
            } },
            summary: { type: 'string' },
            takeaway: { type: 'string' },
            items: { type: 'array', items: { type: 'string' } },
            nodes: { type: 'array', items: { type: 'string' }, description: 'SmartArt 节点，1–8 个' },
            chart: {
              type: 'object',
              properties: {
                kind: { enum: ['bar', 'line', 'area', 'pie', 'doughnut'] },
                categories: { type: 'array', items: { type: 'string' } },
                series: {
                  type: 'array',
                  items: {
                    type: 'object', required: ['name', 'values'],
                    properties: {
                      name: { type: 'string' },
                      values: { type: 'array', items: { type: 'number' } },
                    },
                  },
                },
                catAxisTitle: { type: 'string' },
                valAxisTitle: { type: 'string' },
                legendPos: { enum: ['none', 'b', 't', 'l', 'r'] },
                gridlines: { type: 'boolean' },
                dataLabels: { type: 'boolean' },
                gapWidthPct: { type: 'number' },
                unit: { type: 'string', description: '同一图表采用的单位' },
                categoryUnits: { type: 'array', items:{type:'string'}, description: '可选的逐分类单位；不一致时必须拆图或明确归一化' },
              },
            },
            image: {
              type: 'object',
              properties: {
                dataUrl: { type: 'string' },
                assetPath: { type: 'string', description: 'image 素材在当前工作区的路径，由 office 工具读取' },
                width: { type: 'number', exclusiveMinimum: 0 },
                height: { type: 'number', exclusiveMinimum: 0 },
                fit: { type: 'string', enum: ['contain'], description: '保持图片完整比例，编辑器根据真实尺寸计算' },
              },
            },
            images: { type:'array',description:'多图页素材列表，每张独立保留实际比例',items:{type:'object',properties:{
              dataUrl:{type:'string'},assetPath:{type:'string'},width:{type:'number'},height:{type:'number'},fit:{type:'string',enum:['contain']},
            }}},
          },
        },
      },
    },
    description: '可选的原生整页预设。提供 slideId 和 content 自动选页，也可指定预设；允许复用同一版式。'
      + '只适用于空白页，容量与事实在写入前校验。无匹配时可使用 slide_compose 或原生操作自由构图，不必改写内容来通过匹配。'
      + '回执 presetPages 给出角色到真实元素 ID 的映射，图表样式在同次命令内应用。候选查询与隔离预览仅在需要时使用。',
  },
]

export function getSlidesCapabilities(
  elementType?: string,
  requestedOperations?: readonly string[],
): SlidesCapabilitiesResult {
  const known = new Map(directCapabilities.map((capability) => [capability.op, capability]))
  const names = [...new Set(requestedOperations ?? [])]
  const available = directCapabilities.filter((c) => !elementType || !c.supportedElementTypes || c.supportedElementTypes.includes(elementType))
  const unsupportedOperations = names.filter((name) => !known.has(name))
  const inapplicableOperations = names.filter((name) => known.has(name) && !available.some((c) => c.op === name))
  const requested = names.filter((name) => available.some((c) => c.op === name))
  const detailed = new Set(requested.slice(0, 3))
  const operations = (names.length ? available.filter((c) => detailed.has(c.op)) : available)
    .map(({ op, payloadSchema, description }) => ({ op, description, ...(detailed.has(op) ? { payloadSchema } : {}) }))
  return { mode: 'capabilities', documentType: 'slides', operations,
    availableOperations: available.map((c) => c.op), unsupportedOperations, inapplicableOperations,
    nextOperations: requested.slice(3),
    note: '未指定 operations 时仅返回操作目录；指定实际名称读取参数，每次最多3项，剩余见 nextOperations。未知名称列在 unsupportedOperations，不影响已知项。改品牌色用 inspect palette + slide_replace_colors 原位修改，不需要关闭或新建文稿。',
    ...(!names.length ? { designs: [...DESIGN_CATALOG] } : {}),
  }
}
