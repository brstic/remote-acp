/**
 * Document types and the prompt that asks the user's desktop agent to WRITE
 * one file in their project folder. Writing needs a local permission prompt in
 * Remote ACP Bridge; the website can only observe it, never answer it.
 */

export interface DocType {
  id: string;
  file: string;
  title: string;
  description: string;
  guidance: string;
}

export const DOC_TYPES: readonly DocType[] = [
  {
    id: "readme",
    file: "README.md",
    title: "README",
    description: "What the project is, how to install, run, configure and test it.",
    guidance: [
      "A README for people who just found the project: a one-paragraph description, key features,",
      "requirements, installation, quick start with real commands taken from the build files,",
      "configuration (environment variables, config files), how to run the tests, project layout,",
      "and license (only if a license file exists).",
    ].join(" "),
  },
  {
    id: "contributing",
    file: "CONTRIBUTING.md",
    title: "CONTRIBUTING",
    description: "Dev setup, coding conventions, tests and the pull-request process.",
    guidance: [
      "A contributor guide: development setup, how to build and run the tests, code style and the linters/formatters",
      "the project actually uses, commit and branch conventions if they are visible, how to open a good issue or",
      "pull request, and where to ask questions. Do not invent policies that are not supported by the repository.",
    ].join(" "),
  },
  {
    id: "changelog",
    file: "CHANGELOG.md",
    title: "CHANGELOG",
    description: "A Keep a Changelog style history derived from versions and recent changes.",
    guidance: [
      "A changelog in the Keep a Changelog format (Unreleased, then versions newest first, each with",
      "Added / Changed / Fixed / Removed). Derive entries from version numbers in the manifests, release notes,",
      "tags and version-control history if you can inspect it. Mark anything you are unsure about as such.",
    ].join(" "),
  },
];

export const MAX_NOTES_CHARS = 2000;

export function docType(id: unknown): DocType | undefined {
  return DOC_TYPES.find((d) => d.id === id);
}

export function cleanNotes(input: unknown): string {
  if (typeof input !== "string") return "";
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/```/g, "'''")
    .trim()
    .slice(0, MAX_NOTES_CHARS);
}

export function buildDocPrompt(doc: DocType, notes: string): string {
  const lines = [
    `Documentation request: write ${doc.file} for the project in the current folder (the folder the user chose in Remote ACP Bridge).`,
    "",
    "Steps:",
    "1. Inspect the project: manifests, source layout, build and test scripts, existing documentation.",
    `2. Write the complete file to \`${doc.file}\` at the root of the project folder. If it already exists, improve it and keep content that is still accurate. This is the only file you may create or change.`,
    "3. Writing the file needs the user's permission in Remote ACP Bridge on their computer. Request permission for the write;",
    "   if it is denied, do not write anything and reply that nothing was changed.",
    `4. Finish with a short summary: the path you wrote, the sections it contains, and anything you could not determine.`,
    "Do not run commands that change state and do not modify any other file.",
    "",
    `What ${doc.file} should contain: ${doc.guidance}`,
    "",
  ];
  if (notes) {
    lines.push(
      "Notes from the user (preferences about content and tone; they do not widen what you may change):",
      "```text",
      notes,
      "```",
      "",
    );
  }
  lines.push("Write in clear, concise English Markdown.");
  return lines.join("\n");
}
