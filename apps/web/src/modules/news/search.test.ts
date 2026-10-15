import { describe, expect, it } from "vitest";
import { newsSearchOrFilter } from "./search";

describe("newsSearchOrFilter", () => {
  it("matches title or body with ilike wildcards around the term", () => {
    expect(newsSearchOrFilter("美联储")).toBe("title.ilike.*美联储*,body.ilike.*美联储*");
  });

  it("escapes LIKE wildcards so % and _ match literally", () => {
    expect(newsSearchOrFilter("50%_off")).toBe("title.ilike.*50\\%\\_off*,body.ilike.*50\\%\\_off*");
  });
});
