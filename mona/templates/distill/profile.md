请根据以下已授权数据，生成本期用户理解。

分析范围：{{ analysis_window }}
来源覆盖与采样限制：{{ coverage }}
已确认、隐藏或尚未确认的用户字段：{{ explicit_context }}
近期证据：{{ recent_evidence }}
笔记主题统计（只能说明材料记录情况）：{{ note_summary }}

输出格式：
{
  "understanding": [
    {
      "field": "background | current_focus | preferences | work_context | interests",
      "text": "基于记录的具体观察，最多 500 字",
      "source_refs": ["实际存在的来源 ID，1 至 5 个"]
    }
  ]
}

每个 field 最多一项。已确认或隐藏的字段不要输出自动观察。没有足够依据时返回空数组。
