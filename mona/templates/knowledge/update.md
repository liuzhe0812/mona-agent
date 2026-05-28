你是一个知识库编译器。以下文件发生了变更，请更新受影响的 Wiki 页。

## 变更文件
{% for change in changes %}
- {{ change.path }} ({{ change.type }})
  {% if change.diff_summary %}变更摘要: {{ change.diff_summary }}{% endif %}
{% endfor %}

## 受影响的现有 Wiki 页
{% for page in affected_pages %}
### {{ page.filename }}
{{ page.content[:500] }}...
{% endfor %}

请更新这些 Wiki 页，保持交叉引用和反向链接的正确性。

以 JSON 格式返回：
{
  "pages": [
    {
      "title": "",
      "filename": "",
      "content": "",
      "tags": [],
      "source_files": []
    }
  ]
}
