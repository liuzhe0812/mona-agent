"""Tests for the dataframe SQL query tool."""

from __future__ import annotations

import json

import pytest

from mona.agent.tools.dataframe import DataframeTool, DataframeToolConfig


@pytest.fixture
def tool(tmp_path):
    return DataframeTool(workspace=tmp_path, config=DataframeToolConfig())


@pytest.fixture
def csv_file(tmp_path):
    f = tmp_path / "sales.csv"
    f.write_text("product,qty,price\napple,10,2.5\nbanana,5,1.0\ncherry,20,3.0\n", encoding="utf-8")
    return f


@pytest.fixture
def json_file(tmp_path):
    f = tmp_path / "users.json"
    f.write_text(json.dumps([
        {"name": "Alice", "age": 30, "city": "NYC"},
        {"name": "Bob", "age": 25, "city": "LA"},
        {"name": "Carol", "age": 35, "city": "NYC"},
    ]), encoding="utf-8")
    return f


@pytest.mark.asyncio
async def test_select_all_csv(tool, csv_file):
    result = await tool.execute(sql="SELECT * FROM sales", files=[str(csv_file)])
    assert "apple" in result
    assert "banana" in result
    assert "cherry" in result
    assert "| product | qty | price |" in result


@pytest.mark.asyncio
async def test_select_with_where(tool, csv_file):
    result = await tool.execute(
        sql="SELECT product FROM sales WHERE qty > 8",
        files=[str(csv_file)],
    )
    assert "apple" in result
    assert "cherry" in result
    assert "banana" not in result


@pytest.mark.asyncio
async def test_aggregate_query(tool, csv_file):
    result = await tool.execute(
        sql="SELECT SUM(qty * price) AS revenue FROM sales",
        files=[str(csv_file)],
    )
    # 10*2.5 + 5*1.0 + 20*3.0 = 25 + 5 + 60 = 90
    assert "90" in result


@pytest.mark.asyncio
async def test_group_by(tool, csv_file):
    result = await tool.execute(
        sql="SELECT product, SUM(qty) AS total FROM sales GROUP BY product ORDER BY total DESC",
        files=[str(csv_file)],
    )
    # cherry (20) should come before apple (10) before banana (5)
    lines = result.split("\n")
    # Find the data rows (skip header + separator)
    data_lines = [ln for ln in lines if ln.startswith("| ") and "---" not in ln and "product" not in ln]
    assert len(data_lines) == 3
    assert "cherry" in data_lines[0]
    assert "apple" in data_lines[1]
    assert "banana" in data_lines[2]


@pytest.mark.asyncio
async def test_json_file_query(tool, json_file):
    result = await tool.execute(
        sql="SELECT name, age FROM users WHERE city = 'NYC'",
        files=[str(json_file)],
    )
    assert "Alice" in result
    assert "Carol" in result
    assert "Bob" not in result


@pytest.mark.asyncio
async def test_join_across_files(tool, tmp_path, csv_file):
    # Create a second CSV to join with
    cats = tmp_path / "categories.csv"
    cats.write_text("product,category\napple,fruit\nbanana,fruit\ncherry,berry\n", encoding="utf-8")
    result = await tool.execute(
        sql="SELECT s.product, s.qty, c.category FROM sales s JOIN categories c ON s.product = c.product",
        files=[str(csv_file), str(cats)],
    )
    assert "fruit" in result
    assert "berry" in result


@pytest.mark.asyncio
async def test_rejects_non_select(tool, csv_file):
    result = await tool.execute(
        sql="DELETE FROM sales",
        files=[str(csv_file)],
    )
    assert "Error" in result
    assert "SELECT" in result


@pytest.mark.asyncio
async def test_file_not_found(tool):
    result = await tool.execute(
        sql="SELECT * FROM x",
        files=["/nonexistent/file.csv"],
    )
    assert "Error" in result
    assert "not found" in result


@pytest.mark.asyncio
async def test_unsupported_file_type(tool, tmp_path):
    f = tmp_path / "data.xyz"
    f.write_text("stuff", encoding="utf-8")
    result = await tool.execute(
        sql="SELECT * FROM data",
        files=[str(f)],
    )
    assert "Error" in result
    assert "unsupported" in result.lower()


@pytest.mark.asyncio
async def test_sql_error_returns_loaded_tables(tool, csv_file):
    result = await tool.execute(
        sql="SELECT nonexistent FROM sales",
        files=[str(csv_file)],
    )
    assert "SQL error" in result
    assert "Loaded tables" in result


@pytest.mark.asyncio
async def test_max_rows_truncation(tool, tmp_path):
    f = tmp_path / "many.csv"
    f.write_text("id\n" + "\n".join(str(i) for i in range(100)), encoding="utf-8")
    result = await tool.execute(
        sql="SELECT * FROM many",
        files=[str(f)],
        max_rows=10,
    )
    assert "showing first 10" in result
    assert "100 rows total" in result


@pytest.mark.asyncio
async def test_jsonl_file(tool, tmp_path):
    f = tmp_path / "events.jsonl"
    f.write_text(
        '{"event": "click", "page": "home"}\n'
        '{"event": "view", "page": "about"}\n',
        encoding="utf-8",
    )
    result = await tool.execute(
        sql="SELECT event FROM events",
        files=[str(f)],
    )
    assert "click" in result
    assert "view" in result


@pytest.mark.asyncio
async def test_table_name_sanitization(tool, tmp_path):
    """File with weird chars in stem should still produce a usable table name."""
    f = tmp_path / "my-data 2024.csv"
    f.write_text("x,y\n1,2\n", encoding="utf-8")
    result = await tool.execute(
        sql="SELECT * FROM my_data_2024",
        files=[str(f)],
    )
    assert "Loaded tables" in result
    assert "my_data_2024" in result
