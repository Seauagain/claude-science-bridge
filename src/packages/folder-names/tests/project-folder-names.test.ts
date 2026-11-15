import { describe, expect, it } from "vitest";
import { type NamedProject, projectFolderNames } from "../index.ts";

/** The folder names chosen for `projects`, in their order. */
function folderNames(projects: NamedProject[]): string[] {
  return projectFolderNames(projects).map(({ folderName }) => folderName);
}

/** The folder name of a project that shares its name with no other. */
function folderNameFor(name: string): string | undefined {
  return folderNames([{ projectId: "proj_aaaaaaaaaaaa", name }])[0];
}

describe("the folder name of a project", () => {
  it("is the project's name when that is a valid folder name everywhere", () => {
    expect(folderNameFor("Protein folding")).toBe("Protein folding");
  });

  it.each(["蛋白质折叠 研究", "Étude d'été №2", "🧬 genome", "v1.0 (final) & more"])(
    "keeps %j as it is",
    (name) => {
      expect(folderNameFor(name)).toBe(name);
    },
  );

  it("replaces the characters Windows does not allow in a name", () => {
    expect(folderNameFor('a<b>c:d"e/f\\g|h?i*j')).toBe("a_b_c_d_e_f_g_h_i_j");
  });

  it("replaces control characters", () => {
    expect(folderNameFor("line\nbreak\ttab\u0000null\u007fdelete")).toBe(
      "line_break_tab_null_delete",
    );
  });

  it.each([
    { name: "  padded  ", folder: "padded" },
    { name: "Results. . ", folder: "Results" },
    { name: "v1.0.", folder: "v1.0" },
    { name: "trailing space　", folder: "trailing space" },
  ])("drops the spaces around $name and the dots after it", ({ name, folder }) => {
    expect(folderNameFor(name)).toBe(folder);
  });

  it.each([
    { name: "CON", folder: "_CON" },
    { name: "prn", folder: "_prn" },
    { name: "Aux", folder: "_Aux" },
    { name: "NUL", folder: "_NUL" },
    { name: "COM1", folder: "_COM1" },
    { name: "lpt9", folder: "_lpt9" },
    { name: "NUL.txt", folder: "_NUL.txt" },
    { name: "con.", folder: "_con" },
  ])("keeps $name, a device name on Windows, from being the folder name", ({ name, folder }) => {
    expect(folderNameFor(name)).toBe(folder);
  });

  it.each(["console", "Conference notes", "COM10", "lpt", "nullable"])(
    "keeps %j, which only resembles a device name",
    (name) => {
      expect(folderNameFor(name)).toBe(name);
    },
  );

  it.each(["", "   ", ".", "..", "...", " . . "])(
    "falls back to a fixed name for %j, of which nothing is left",
    (name) => {
      expect(folderNameFor(name)).toBe("Untitled project");
    },
  );

  it("shortens a very long name to 60 characters", () => {
    expect(folderNameFor("x".repeat(300))).toBe("x".repeat(60));
    expect(folderNameFor("研".repeat(100))).toBe("研".repeat(60));
  });

  it("shortens between characters, never inside one, and stays within 255 bytes", () => {
    const folder = folderNameFor("🧬".repeat(100)) ?? "";

    expect(folder).toBe("🧬".repeat(60));
    expect(Buffer.byteLength(folder, "utf8")).toBeLessThanOrEqual(255);
  });

  it("drops a dot or space that shortening leaves at the end", () => {
    expect(folderNameFor(`${"a".repeat(59)}. and more`)).toBe("a".repeat(59));
  });
});

describe("the folder names of projects that would share one", () => {
  it("carry the identifier of their project, and leave other projects alone", () => {
    const names = folderNames([
      { projectId: "proj_aaaaaaaaaaaa", name: "Protein folding" },
      { projectId: "proj_bbbbbbbbbbbb", name: "Climate model" },
      { projectId: "proj_cccccccccccc", name: "Protein folding" },
    ]);

    expect(names).toEqual([
      "Protein folding (proj_aaaaaaaaaaaa)",
      "Climate model",
      "Protein folding (proj_cccccccccccc)",
    ]);
  });

  it("are told apart when the names differ only by letter case", () => {
    const names = folderNames([
      { projectId: "proj_aaaaaaaaaaaa", name: "Protein Folding" },
      { projectId: "proj_bbbbbbbbbbbb", name: "protein folding" },
    ]);

    expect(names).toEqual([
      "Protein Folding (proj_aaaaaaaaaaaa)",
      "protein folding (proj_bbbbbbbbbbbb)",
    ]);
  });

  it("are told apart when the same letter is written in two Unicode forms", () => {
    const names = folderNames([
      { projectId: "proj_aaaaaaaaaaaa", name: "étude" },
      { projectId: "proj_bbbbbbbbbbbb", name: "étude" },
    ]);

    expect(names).toEqual(["étude (proj_aaaaaaaaaaaa)", "étude (proj_bbbbbbbbbbbb)"]);
  });

  it("are told apart when the names only become the same as folder names", () => {
    const names = folderNames([
      { projectId: "proj_aaaaaaaaaaaa", name: "RNA/DNA" },
      { projectId: "proj_bbbbbbbbbbbb", name: "RNA:DNA" },
      { projectId: "proj_cccccccccccc", name: "RNA_DNA." },
    ]);

    expect(names).toEqual([
      "RNA_DNA (proj_aaaaaaaaaaaa)",
      "RNA_DNA (proj_bbbbbbbbbbbb)",
      "RNA_DNA (proj_cccccccccccc)",
    ]);
  });

  it("are shortened further, so that the identifier fits within the 60 characters", () => {
    const names = folderNames([
      { projectId: "proj_aaaaaaaaaaaa", name: "x".repeat(300) },
      { projectId: "proj_bbbbbbbbbbbb", name: "x".repeat(300) },
    ]);

    expect(names).toEqual([
      `${"x".repeat(40)} (proj_aaaaaaaaaaaa)`,
      `${"x".repeat(40)} (proj_bbbbbbbbbbbb)`,
    ]);
  });

  it("do not depend on the order the projects come in", () => {
    const first = { projectId: "proj_aaaaaaaaaaaa", name: "Protein folding" };
    const second = { projectId: "proj_bbbbbbbbbbbb", name: "Protein folding" };

    expect(folderNames([second, first])).toEqual([
      "Protein folding (proj_bbbbbbbbbbbb)",
      "Protein folding (proj_aaaaaaaaaaaa)",
    ]);
  });

  it("stay valid and within 60 characters whatever the identifier is", () => {
    const names = folderNames([
      { projectId: `proj/${"a".repeat(100)}`, name: "Protein folding" },
      { projectId: "proj_bbbbbbbbbbbb", name: "Protein folding" },
    ]);

    expect(names).toEqual([
      `Protein folding (proj_${"a".repeat(19)})`,
      "Protein folding (proj_bbbbbbbbbbbb)",
    ]);
  });
});
