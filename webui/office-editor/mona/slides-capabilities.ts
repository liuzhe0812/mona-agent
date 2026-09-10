import { COMPOSE_FIELDS } from './slides-layout'

export interface SlidesCapability {
  op: string
  payloadSchema: Record<string, unknown>
  description: string
  supportedElementTypes?: readonly string[]
}

export interface SlidesCapabilitiesResult {
  mode: 'capabilities'
  documentType: 'slides'
  operations: Array<Pick<SlidesCapability, 'op' | 'payloadSchema' | 'description'>>
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
    fontFamily: { type: 'string' },
    fontSize: { type: 'number', exclusiveMinimum: 0 },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    color: { type: 'string', description: '#RRGGBB' },
  },
}

const directCapabilities: SlidesCapability[] = [
  {
    op: 'slide_set_text',
    payloadSchema: {
      type: 'object',
      required: ['slideId', 'elementId', 'text'],
      properties: { slideId, elementId, text: { type: 'string' } },
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
        style: {
          type: 'object',
          properties: {
            textColor: { type: 'string', description: '#RRGGBB' },
            titleColor: { type: 'string', description: '#RRGGBB' },
            axisLabelColor: { type: 'string', description: '#RRGGBB' },
            axisTitleColor: { type: 'string', description: '#RRGGBB' },
            legendColor: { type: 'string', description: '#RRGGBB' },
            dataLabelColor: { type: 'string', description: '#RRGGBB' },
          },
        },
      },
    },
    description: '设置原生图表的文字颜色；字段以图表读取结果的 supportedTextStyleFields 为准。',
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
      required: ['slideId', 'x', 'y', 'width', 'height', 'text'],
      properties: {
        slideId,
        ...geometry,
        text: { type: 'string' },
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
          description: '按顺序叠放的 grid item；type 为 text、shape、image 或 svg。',
          items: {
            type: 'object',
            required: ['type', 'column', 'row'],
            properties: {
              type: { enum: ['text', 'shape', 'image', 'svg'] },
              column: { type: 'integer', minimum: 0 },
              row: { type: 'integer', minimum: 0 },
              columnSpan: { type: 'integer', minimum: 1 },
              rowSpan: { type: 'integer', minimum: 1 },
              inset: { type: 'number', minimum: 0 },
              text: { type: 'string' },
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
]

export function getSlidesCapabilities(
  elementType?: string,
  requestedOperations?: readonly string[],
): SlidesCapabilitiesResult {
  if (requestedOperations) {
    const known = new Set(directCapabilities.map((capability) => capability.op))
    const invalid = requestedOperations.filter((op) => !known.has(op))
    if (invalid.length > 0) {
      throw new Error(`不支持的幻灯片能力操作：${[...new Set(invalid)].join(', ')}`)
    }
  }
  const requested = requestedOperations && requestedOperations.length > 0
    ? new Set(requestedOperations)
    : undefined
  const operations = directCapabilities
    .filter((capability) => (!requested || requested.has(capability.op))
      && (!elementType || !capability.supportedElementTypes
      || capability.supportedElementTypes.includes(elementType))
    )
    .map(({ op, payloadSchema, description }) => ({ op, payloadSchema, description }))
  return { mode: 'capabilities', documentType: 'slides', operations }
}
