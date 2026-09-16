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
        <DbIcon name="mysql" />
        <DbIcon name="sqlite" />
        <DbIcon name="table" />
        <DbIcon name="view" />
        <DbIcon name="procedure" />
        <DbIcon name="play" className="text-foreground" />
      </>,
    );

    expect(container.querySelectorAll("svg")[0].querySelector("ellipse[rx='7.25']")).toHaveAttribute("fill", "currentColor");
    expect(container.querySelector("[fill*='db-table-icon']")).toBeInTheDocument();
    expect(container.querySelector("[fill*='db-procedure-icon']")).toBeInTheDocument();
    expect(container.querySelector(".text-foreground")).toBeInTheDocument();
  });

  it("uses distinct driver symbols for MySQL and SQLite connections", () => {
    const { container } = render(<><DbIcon name="mysql" /><DbIcon name="sqlite" /></>);
    expect(container.querySelector("[data-symbol='mysql-dolphin'] rect")).toHaveAttribute("fill", "hsl(var(--info-strong))");
    expect(container.querySelector("[data-symbol='mysql-dolphin'] path")).toHaveAttribute("fill", "hsl(var(--primary-foreground))");
    expect(container.querySelector("[data-symbol='sqlite-database'] ellipse")).toBeInTheDocument();
  });

  it("uses a large filled three-layer database cylinder", () => {
    const { container } = render(<DbIcon name="database" />);
    const svg = container.querySelector("svg")!;
    expect(svg.querySelector("ellipse[rx='7.25']")).toHaveAttribute("fill", "currentColor");
    expect(svg.querySelectorAll("path")).toHaveLength(2);
    expect(svg.querySelector("path[stroke*='background']")?.getAttribute("d")).toContain("M2.75 8.9");
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
