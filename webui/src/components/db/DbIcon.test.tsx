import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { filterDatabaseTree } from "@/components/db/ConnectionTree";
import { DbIcon, dbIconNames } from "@/components/db/DbIcon";
import type { DatabaseObject } from "@/components/db/types";

describe("DbIcon", () => {
  it("provides every database icon in the shared 20px SVG frame", () => {
    const { container } = render(
      <>
        {dbIconNames.map((name) => (
          <DbIcon key={name} name={name} />
        ))}
      </>,
    );

    const icons = Array.from(container.querySelectorAll("svg"));
    expect(icons).toHaveLength(dbIconNames.length);
    for (const icon of icons) {
      expect(icon).toHaveAttribute("viewBox", "0 0 20 20");
      expect(icon).toHaveAttribute("stroke", "currentColor");
    }
  });

  it("keeps database domain colors semantic while toolbar actions inherit currentColor", () => {
    const { container } = render(
      <>
        <DbIcon name="database" />
        <DbIcon name="connection" />
        <DbIcon name="table" />
        <DbIcon name="view" />
        <DbIcon name="procedure" />
        <DbIcon name="play" className="text-foreground" />
      </>,
    );

    expect(container.querySelector(".text-success")).toBeInTheDocument();
    expect(container.querySelectorAll(".text-info")).toHaveLength(3);
    expect(container.querySelector(".text-warning")).toBeInTheDocument();
    expect(container.querySelector(".text-foreground")).toBeInTheDocument();
  });

  it("uses the approved professional shapes for structure, index, columns, DDL, and sort", () => {
    const { container } = render(
      <>
        <DbIcon name="structure" />
        <DbIcon name="index" />
        <DbIcon name="columns" />
        <DbIcon name="ddl" />
        <DbIcon name="sort" />
      </>,
    );
    const [structure, index, columns, ddl, sort] = Array.from(container.querySelectorAll("svg"));

    expect(structure.querySelectorAll("rect")).toHaveLength(1);
    expect(Array.from(structure.querySelectorAll("path")).some((path) => path.getAttribute("d")?.includes("4.75"))).toBe(true);
    expect(index.querySelector("circle")).toBeInTheDocument();
    expect(index.querySelector("path[d*='M10 12']")).toBeInTheDocument();
    expect(columns.querySelector("circle")).toBeInTheDocument();
    expect(ddl).toHaveTextContent("DDL");
    expect(sort.querySelector("path[d*='M6 15V5']")).toBeInTheDocument();
  });
});

describe("filterDatabaseTree", () => {
  it("retains every ancestor when a nested table matches", () => {
    const tree: DatabaseObject[] = [
      {
        name: "analytics",
        schema: null,
        object_type: "database",
        children: [
          {
            name: "表",
            schema: "analytics",
            object_type: "folder",
            children: [
              { name: "orders", schema: "analytics", object_type: "table", children: [] },
              { name: "users", schema: "analytics", object_type: "table", children: [] },
            ],
          },
          {
            name: "视图",
            schema: "analytics",
            object_type: "folder",
            children: [
              { name: "order_summary", schema: "analytics", object_type: "view", children: [] },
            ],
          },
        ],
      },
    ];

    expect(filterDatabaseTree(tree, "summary")).toEqual([
      {
        ...tree[0],
        children: [
          {
            ...tree[0].children[1],
            children: [tree[0].children[1].children[0]],
          },
        ],
      },
    ]);
  });
});
