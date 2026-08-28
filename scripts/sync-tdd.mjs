import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import console from "node:console";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = join(repoRoot, "scripts", "tdd-manifest.json");
const defaultSrc = join(repoRoot, "..", "learn-java-with-tests");
const src = process.env.TDD_SRC ?? defaultSrc;
const outputDir = join(repoRoot, "src", "content", "tdd");

let srcExists = true;
try {
  await access(src);
} catch {
  srcExists = false;
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
await mkdir(outputDir, { recursive: true });

let synced = 0;
for (const chapter of manifest) {
  const readmePath = join(
    src,
    "src",
    "main",
    "java",
    chapter.package,
    "README.md",
  );

  let body;
  try {
    body = await readFile(readmePath, "utf8");
  } catch {
    console.warn(
      `tdd:sync skip ${chapter.slug}: README not found at ${readmePath}`,
    );
    continue;
  }

  body = body.replace(/^#.*\n/, "").trimStart();
  body = body.replaceAll(
    /\]\(\.\.\/([a-z0-9_-]+)\/README\.md\)/g,
    "](/tdd/$1/)",
  );

  const frontmatter = [
    "---",
    `title: "${chapter.title}"`,
    `description: "${chapter.description}"`,
    `order: ${chapter.order}`,
    `package: "${chapter.package}"`,
    "---",
    "",
    "",
  ].join("\n");

  await writeFile(
    join(outputDir, `${chapter.slug}.md`),
    `${frontmatter}${body}\n`,
    "utf8",
  );
  synced += 1;
}

if (synced === 0) {
  if (srcExists) {
    console.error(
      `tdd:sync — ${src} exists but no chapter READMEs matched the manifest. ` +
        "Check tdd-manifest.json package names against the course repo.",
    );
    process.exit(1);
  }
  console.warn(
    `tdd:sync — source ${src} not found locally; pass TDD_SRC or let CI clone ` +
      "gdguesser/learn-java-with-tests.",
  );
  process.exit(0);
}

console.log(
  `tdd:sync — wrote ${synced}/${manifest.length} chapter files to ${outputDir}`,
);
