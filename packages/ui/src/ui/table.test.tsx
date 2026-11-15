// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table"

afterEach(cleanup);

function DemoTable() {
  return (
    <Table className="extra-class">
      <TableCaption>A demo table</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Score</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Ada</TableCell>
          <TableCell>100</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>Total</TableCell>
          <TableCell>100</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

describe("Table (UI-03 smoke)", () => {
  it("renders a native table with header/body/footer rows and forwards className", () => {
    render(<DemoTable />);
    const table = screen.getByRole("table");
    expect(table).toBeInTheDocument();
    expect(table).toHaveClass("extra-class");
    expect(table).toHaveAttribute("data-slot", "table");

    expect(screen.getByText("A demo table")).toBeInTheDocument();
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
  });

  it("wraps the table in an overflow container", () => {
    render(<DemoTable />);
    const container = screen.getByRole("table").parentElement;
    expect(container).toHaveAttribute("data-slot", "table-container");
  });
});
