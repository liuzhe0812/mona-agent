你是一位用户画像分析师。基于以下来自多个数据源的聚合数据，
构建用户的综合画像。

## 笔记统计

- 笔记总数：{{ notes.total_notes }}
- 笔记本数：{{ notes.total_notebooks }}
- 笔记本分布：{{ notes.notebook_distribution }}
- 热门标签：{{ notes.tag_distribution }}
- 标题中的技术关键词：{{ notes.title_keywords }}
- 每月笔记数：{{ notes.monthly_distribution }}

## 近期笔记标题（样本）

{% for title in notes.recent_titles[:20] %}
- {{ title }}
{% endfor %}

## 邮件统计

- 邮件总数：{{ email.total_emails }}
- 发件人数：{{ email.total_senders }}
- 主要发件人：{{ email.top_senders }}
- 主要主题：{{ email.top_subjects }}
- 每月邮件数：{{ email.monthly_distribution }}

## 工作模式（来自之前的蒸馏）

- 常做任务：{{ work_patterns.frequent_tasks }}
- 偏好工具：{{ work_patterns.preferred_tools }}
- 工作方向：{{ work_patterns.work_focus }}

## 任务

分析以上数据，输出用户画像的 JSON 对象。
要求基于数据、具体明确——只包含有数据支撑的内容。所有文本值用中文。

只输出合法 JSON（不要 markdown 代码块，不要解释），schema 如下：

{
  "identity": {
    "primary_role": "用户的主要角色，如 '开发者'、'研究员'、'项目经理'",
    "secondary_roles": ["其他可见角色"],
    "timezone_hint": "如果能从活跃模式推断出时区"
  },
  "tech_stack": [
    {"area": "如 '编程语言'", "items": ["Python", "Rust", "TypeScript"]}
  ],
  "interests": ["3-7 个从笔记/邮件可见的兴趣领域"],
  "knowledge_structure": {
    "deep_areas": ["笔记数量多、深度知识领域"],
    "exploring_areas": ["笔记少但在增长的探索领域"]
  },
  "relationships": {
    "frequent_contacts": ["前 3-5 位邮件联系人"],
    "collaboration_pattern": "一句话描述协作模式"
  },
  "work_rhythm": {
    "active_hours": "最活跃的时段",
    "intensity": "轻度 | 适中 | 高强度"
  },
  "confidence": 0.0-1.0
}

置信度参考标准：
- 0.8+：50+ 笔记，20+ 邮件，模式清晰
- 0.5-0.8：有部分数据但存在缺口
- 0.0-0.5：数据稀疏，低置信度
