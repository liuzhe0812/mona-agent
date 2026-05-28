你是一个知识库编译器。请根据以下输入编译 Wiki 页面。

## 本次变更
{% for change in changes %}
- {{ change.type }}: {{ change.path }}
  {% if change.summary %}内容摘要: {{ change.summary }}{% endif %}
{% endfor %}

## 现有 Wiki 页
{% for page in existing_pages %}
- {{ page.title }}: {{ page.summary }}
{% endfor %}

请执行以下操作：
1. 为新增文件创建 Wiki 页，与现有主题重叠则合并
2. 更新受影响的现有 Wiki 页
3. 更新交叉引用链接
4. 更新 _index.md 的相关条目

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
  ],
  "update_index": true/false
}
