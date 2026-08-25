import { describe, expect, it } from "vitest";
import { renderMemoryText } from "../src/state/memory-utils.js";

const longContent =
  "Always pin lockfiles before dependency updates so installs stay reproducible across every supported runtime.";
const surrogateContent = `${"a".repeat(79)}😀tail`;
const rawSurrogateTitle = surrogateContent.slice(0, 80);

describe("renderMemoryText", () => {
  it.each([
    {
      name: "short derived title",
      title: "Always pin lockfiles",
      content: "Always pin lockfiles",
      expected: "Always pin lockfiles",
    },
    {
      name: "80-character derived title",
      title: longContent.slice(0, 80),
      content: longContent,
      expected: longContent,
    },
    {
      name: "legacy raw surrogate slice",
      title: rawSurrogateTitle,
      content: surrogateContent,
      expected: surrogateContent,
    },
    {
      name: "safe surrogate slice",
      title: rawSurrogateTitle.slice(0, -1),
      content: surrogateContent,
      expected: surrogateContent,
    },
    {
      name: "authored prefix title",
      title: "Database migration",
      content: "Database migration requires downtime.",
      expected: "Database migration: Database migration requires downtime.",
    },
  ])("renders $name", ({ title, content, expected }) => {
    expect(renderMemoryText({ title, content })).toBe(expected);
  });
});
