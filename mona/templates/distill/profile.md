你是一位用户画像分析师。基于以下来自多个数据源的聚合数据，
构建用户的综合画像。

## 用户已知偏好（先验，请勿矛盾）

以下是用户在 USER.md 中手写的偏好和背景，作为分析先验。
你的输出应与这些信息一致，不要产生矛盾结论。若对话数据与之冲突，以先验为准。

{{ user_prior }}

## Agent 对话主题（最近 {{ sessions.total_sessions }} 个会话）

{% for topic in sessions.topics %}
### 会话 {{ loop.index }}：{{ topic.title }}
- 时间：{{ topic.updated_at }}
- 涉及工具：{{ topic.tools_used }}
- 用户消息：
{{ topic.user_messages }}

{% endfor %}

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

{% if prev_pain_points or prev_open_questions %}
## 历史画像中的痛点与开放问题（供继承）

以下是上一次蒸馏提炼的痛点，请核对本期数据：仍然成立的继承并更新 last_seen，
已解决或不再出现的不要保留。

- 历史痛点：{{ prev_pain_points }}
- 历史开放问题：{{ prev_open_questions }}
{% endif %}

## 任务

分析以上数据，输出用户画像的 JSON 对象。
要求基于数据、具体明确——只包含有数据支撑的内容。所有文本值用中文。

分析重点：
1. **从对话内容提炼用户真正关心的问题、反复纠结的决策、遇到的痛点**——这是最重要的信号，必须落入 pain_points 字段
2. 从笔记和邮件补充技术栈、兴趣领域、协作关系
3. 先验区已声明的偏好直接采纳，不要重复推导

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
  "interests": ["3-7 个从对话/笔记/邮件可见的兴趣领域，要具体不要泛泛"],
  "pain_points": [
    {
      "topic": "用户反复纠结或卡住的问题，一句话",
      "detail": "具体表现：在什么任务里遇到什么困难",
      "last_seen": "最后一次出现该信号的月份，格式 YYYY-MM"
    }
  ],
  "open_questions": ["用户正在探索但尚未有结论的问题，0-3 个"],
  "knowledge_structure": {
    "deep_areas": ["笔记数量多、对话中反复深入讨论的领域"],
    "exploring_areas": ["笔记少但在对话中可见正在探索的领域"]
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

pain_points 规则：
- 只收录对话中出现 2 次以上、或用户明确表达困扰的问题，不要臆测
- 最多 5 条，按最近活跃度排序
- 如果历史画像中已有 pain_points，请继承仍然成立的条目并更新其 last_seen；已解决的不要保留
- 无信号时返回空数组，禁止编造

置信度参考标准：
- 0.8+：50+ 笔记，20+ 邮件，20+ 会话，模式清晰
- 0.5-0.8：有部分数据但存在缺口
- 0.0-0.5：数据稀疏，低置信度
