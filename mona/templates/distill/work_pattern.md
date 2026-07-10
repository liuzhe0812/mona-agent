你是一位用户行为分析师。基于以下聚合的工具调用数据，
提炼用户的工作模式。

## 工具调用统计

- 扫描会话数：{{ total_sessions }}
- 工具调用总数：{{ total_calls }}
- 时间范围：{{ earliest }} 至 {{ latest }}

## 高频工具（按调用次数排序）

{% for item in top_tools %}
{{ loop.index }}. {{ item.tool }} — {{ item.count }} 次
{% endfor %}

## 工具调用链（常见序列）

{% for item in tool_chains %}
- {{ item.chain }}（{{ item.count }} 次）
{% endfor %}

## 每小时活跃度分布

{% for hour, count in hourly_distribution.items() %}
- {{ hour }}:00 — {{ count }} 次
{% endfor %}

## 各工具成功率

{% for tool, counts in tool_success.items() %}
- {{ tool }}：{{ counts.success }}/{{ counts.total }} 成功
{% endfor %}

## 任务

分析以上数据，输出描述用户工作模式的 JSON 对象。
要求具体、明确——避免空泛的描述。所有文本值用中文。

只输出合法 JSON（不要 markdown 代码块，不要解释），schema 如下：

{
  "frequent_tasks": ["3-5 项用户常做的任务类型，如 '编写代码'、'整理邮件'、'搜索笔记'"],
  "preferred_tools": ["3-5 项用户最依赖的工具"],
  "tool_chains": ["2-3 条用户常用的工具调用序列"],
  "active_hours": "用户最活跃的时段描述，如 '上午 9-12 点，晚上 20-23 点'",
  "output_style": "简洁 | 详细 | 自适应",
  "work_focus": "1-2 句话总结用户的主要工作方向",
  "confidence": 0.0-1.0
}

置信度参考标准：
- 0.8+：20+ 会话，模式清晰
- 0.5-0.8：5-20 会话，部分模式可见
- 0.0-0.5：不足 5 会话，数据不足
