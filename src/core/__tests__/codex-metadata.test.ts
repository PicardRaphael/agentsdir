import { describe, expect, it } from "vitest";
import {
  ICON_NAMES,
  renderOpenAiYaml,
  renderSkillIcon,
} from "../codex-metadata.js";
import { CliError } from "../errors.js";
import type { SkillFrontmatter } from "../frontmatter.js";

function fm(overrides: Partial<SkillFrontmatter> = {}): SkillFrontmatter {
  return {
    name: "mon-skill",
    description: "Fait X de bout en bout. Use when the user asks to X, Y or Z.",
    displayName: "Mon Skill",
    shortDescription: "Fait X de bout en bout, en autonomie",
    color: "#1F4E8C",
    icon: "badge-check",
    defaultPrompt: "Use $mon-skill to do X end to end.",
    implicit: false,
    disableModelInvocation: true,
    argumentHint: undefined,
    ...overrides,
  };
}

describe("06 - codex metadata", () => {
  it("Given the documented frontmatter, When openai.yaml is rendered, Then the output matches the official Codex format byte for byte", () => {
    expect(renderOpenAiYaml(fm())).toBe(
      [
        "interface:",
        '  display_name: "Mon Skill"',
        '  short_description: "Fait X de bout en bout, en autonomie"',
        '  icon_small: "./assets/icon.svg"',
        '  icon_large: "./assets/icon.svg"',
        '  brand_color: "#1F4E8C"',
        '  default_prompt: "Use $mon-skill to do X end to end."',
        "",
        "policy:",
        "  allow_implicit_invocation: false",
        "",
      ].join("\n"),
    );
  });

  it("Given values containing quotes and backslashes, When openai.yaml is rendered, Then they are escaped in the double-quoted YAML strings", () => {
    const yaml = renderOpenAiYaml(fm({ displayName: 'Say "hi" C:\\tools' }));
    expect(yaml).toContain('display_name: "Say \\"hi\\" C:\\\\tools"');
  });

  it("Given implicit true, When openai.yaml is rendered, Then policy allows implicit invocation", () => {
    expect(renderOpenAiYaml(fm({ implicit: true }))).toContain(
      "allow_implicit_invocation: true",
    );
  });

  it("Given a known icon, When the icon is rendered, Then it is a 128x128 SVG with the color-filled rounded rect and white strokes of width 1.8", () => {
    const svg = renderSkillIcon(fm({ icon: "terminal" }));
    expect(svg).toContain('width="128" height="128" viewBox="0 0 128 128"');
    expect(svg).toContain(
      '<rect width="128" height="128" rx="5" fill="#1F4E8C"/>',
    );
    expect(svg).toContain('stroke="#FFFFFF" stroke-width="1.8"');
    expect(svg).toContain('<path d="M12 19h8"/>');
    expect(svg).toContain("<title>Mon Skill</title>");
    expect(svg).toContain('aria-label="Mon Skill"');
  });

  it("Given a display name with XML-sensitive characters, When the icon is rendered, Then title and aria-label are escaped", () => {
    const svg = renderSkillIcon(fm({ displayName: 'R&D "Core" <X>' }));
    expect(svg).toContain("<title>R&amp;D &quot;Core&quot; &lt;X&gt;</title>");
    expect(svg).toContain('aria-label="R&amp;D &quot;Core&quot; &lt;X&gt;"');
  });

  it("Given an unknown icon, When the icon is rendered, Then it fails with exit code 1 and suggests the closest name", () => {
    let thrown: unknown;
    try {
      renderSkillIcon(fm({ icon: "terminl" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(1);
    expect((thrown as CliError).message).toContain('"terminal"');
  });

  it("Given the whole embedded set, When every icon is rendered twice, Then each render is non-empty and byte-for-byte identical (deterministic, no lucide at runtime)", () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(20);
    for (const icon of ICON_NAMES) {
      const first = renderSkillIcon(fm({ icon }));
      const second = renderSkillIcon(fm({ icon }));
      expect(first).toBe(second);
      expect(first.endsWith("</svg>\n")).toBe(true);
      expect(first).not.toContain("\r");
    }
    expect(renderOpenAiYaml(fm())).toBe(renderOpenAiYaml(fm()));
  });
});
