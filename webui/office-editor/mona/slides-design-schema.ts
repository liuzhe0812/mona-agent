import { DESIGN_CATALOG } from './slides-design'
const text = { type: 'string' }
const number = { type: 'number' }
const item = { type: 'object', additionalProperties: false, required: ['label'], properties: { label: text, detail: text, value: { type: ['string', 'number'] }, unit: text } }
const itemList = { type: 'array', items: item, maxItems: 12 }
const rect = { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], properties: { x: number, y: number, width: number, height: number } }
const nodeList = { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: { id: text, label: text } } }
export const designCapability = {
  op: 'slide_add_design',
  description: '创建有完成度的原生设计页或明确 region 内的设计区域；文字按真实排版适配，指标混合字号，信息图形由数据计算。完整页需为空白；不审批、不冻结、不禁止复用。statement可emphasis；metric需metric；evidence需chart+items；waterfall需steps；sankey需sources+targets+links；agenda/items/roadmap/matrix需items，matrix另需axes；comparison需两组groups；image需image+items。内容不截断，原生定制始终可用。',
  payloadSchema: {
    type: 'object', additionalProperties: false, required: ['slideId', 'design', 'content'],
    properties: {
      slideId: text, design: { type: 'string', enum: DESIGN_CATALOG.map((d) => d.id) },
      region: { ...rect, description: 'metric/items/waterfall/sankey/evidence 可组合为正常字号的局部组件，title 可为空；区域为当前预览像素，至少300×180。其它构图用于完整空白页。不会删除现有对象。' },
      focusIndex: { type: 'integer', minimum: 0, description: '强调的条目，默认0。' },
      palette: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['background', 'ink', 'muted', 'accent', 'surface', 'line', 'positive', 'negative'].map((key) => [key, { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }])) },
      content: { type: 'object', additionalProperties: false, required: ['title'], properties: {
        title: text, summary: text, eyebrow: text, source: text, pageLabel: text,
        emphasis: { ...text, description: 'statement专用，必须是标题中的连续原文。' },
        metric: { ...item, description: '主指标value必填；detail排在解读区。' },
        items: { ...itemList, description: '标签/数值/单位/解释分别提供。具体容量由构图决定，不能为匹配删事实。' },
        chart: { type: 'object', additionalProperties: false, required: ['kind', 'categories', 'series'], properties: {
          kind: { type: 'string', enum: ['bar', 'line', 'area', 'pie', 'doughnut'] }, title: text, unit: text,
          categories: { type: 'array', items: text, minItems: 1 },
          series: { type: 'array', minItems: 1, items: { type: 'object', required: ['name', 'values'], properties: { name: text, values: { type: 'array', items: number } } } },
          style: { type: 'object', description: '同slide_add_chart.style，省略时与页面一致。' },
        } },
        steps: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: text, value: number } }, description: '瀑布的正/负/零增减量，不是累计终点。' },
        start: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: text, value: number } },
        unit: text, totalLabel: text, sources: nodeList, targets: nodeList,
        links: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['source', 'target', 'value'], properties: { source: text, target: text, value: { type: 'number', minimum: 0 } } }, description: '引用sources/targets的真实id，由程序汇总节点和带宽。' },
        columns: { type: 'integer', minimum: 1, maximum: 4 },
        groups: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'object', additionalProperties: false, required: ['label', 'items'], properties: { label: text, detail: text, items: { ...itemList, minItems: 1, maxItems: 5 } } } },
        axes: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: text, y: text } },
        image: { type: 'object', additionalProperties: false, properties: { assetPath: text, dataUrl: text, width: number, height: number, fit: { const: 'contain' } }, description: '实际取得的图片路径或dataUrl；编辑器测量真实比例，不能假造路径。' },
      } },
    },
  },
}
export const richTextFields = {
  paragraphs: { type: 'array', minItems: 1, maxItems: 80, items: { type: 'object', required: ['runs'] }, description: '与text二选一。每段{runs:[{text,fontFamily?,fontSize?,bold?,italic?,underline?,color?,letterSpacing?,baseline?}],align?,lineHeight?,spaceBefore?,spaceAfter?}。字号/字距/段距为pt，lineHeight为百分比。用独立run实现局部强调和数字+小单位。' },
  body: { type: 'object', additionalProperties: false, properties: {
    insets: { type: 'object', additionalProperties: false, required: ['l', 't', 'r', 'b'], properties: Object.fromEntries(['l', 't', 'r', 'b'].map((key) => [key, { type: 'number', minimum: 0, maximum: 500 }])) },
    anchor: { enum: ['top', 'middle', 'bottom'] }, wrap: { type: 'boolean' },
  }, description: '内边距为预览像素，与真实排版/保存一致。' },
}
export const pathCapability = {
  supportedElementTypes: ['shape'],
  op: 'slide_add_path', description: '原生可编辑自由形状，不是图片。使用0–1归一化M/L/C/Z指令，不接受SVG/XML/脚本；复杂图形优先使用数据驱动组件。',
  payloadSchema: { type: 'object', additionalProperties: false, required: ['slideId', 'x', 'y', 'width', 'height', 'path'], properties: {
    slideId: text, x: number, y: number, width: number, height: number,
    path: { type: 'array', minItems: 2, maxItems: 256, description: "[['M',x,y],['L',x,y],['C',cx1,cy1,cx2,cy2,x,y],['Z']]；须以M开始，坐标有限且在0–1。" },
    fillColor: { ...text, description: '#RRGGBB或#RRGGBBAA，透明#00000000' }, strokeColor: text, strokeWidthPt: number,
  } },
}
