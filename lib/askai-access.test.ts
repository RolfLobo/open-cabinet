import { describe, it, expect } from "vitest";
import { askaiClosed, askaiEnabled, requestHasAskaiAccess } from "./askai-access";

describe("askai access switch", () => {
  it("is open by default", () => {
    const env = {} as unknown as NodeJS.ProcessEnv;
    expect(askaiEnabled(env)).toBe(true);
    expect(requestHasAskaiAccess(new Request("http://localhost/api/ask"), env)).toBe(true);
  });

  it("ASKAI_CLOSED closes the page and the API", () => {
    for (const v of ["1", "true", "YES"]) {
      const env = { ASKAI_CLOSED: v } as unknown as NodeJS.ProcessEnv;
      expect(askaiClosed(env)).toBe(true);
      expect(askaiEnabled(env)).toBe(false);
      expect(requestHasAskaiAccess(new Request("http://localhost/api/ask"), env)).toBe(false);
    }
    expect(askaiClosed({ ASKAI_CLOSED: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});
