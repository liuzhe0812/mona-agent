# Flowchart Executor — Three-Step XML Generation(占位,Phase 4 完善)

## Three-Step Pipeline

### Step 5a: Verify graph.json
确认 `graph.json` 与 `graph_lock.md` 一致。

### Step 5b: auto_layout.py
```bash
python ${SKILL_DIR}/scripts/auto_layout.py <project_path>
```
输出 `layout.json`,包含每个节点的 x/y 坐标和尺寸。

### Step 5c: build_xml.py
```bash
python ${SKILL_DIR}/scripts/build_xml.py <project_path>
```
读取 `graph.json` + `layout.json`,生成 `diagram.drawio`(mxGraph XML)。

## mxGraph XML Structure

```xml
<mxfile>
  <diagram name="Page-1">
    <mxGraphModel>
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <!-- nodes -->
        <mxCell id="n1" value="标签" style="..." vertex="1" parent="1">
          <mxGeometry x="100" y="100" width="120" height="60" as="geometry" />
        </mxCell>
        <!-- edges -->
        <mxCell id="e1" source="n1" target="n2" style="..." edge="1" parent="1">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

## Quality Checklist

- [ ] XML 语法正确
- [ ] 所有节点有 id、value、style、geometry
- [ ] 所有边有 source、target
- [ ] 坐标来自 layout.json(非手写)
- [ ] 样式与 graph_lock.md 一致
