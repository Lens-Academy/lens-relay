#!/usr/bin/env node

import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const choice = process.argv[2];
if (choice !== "rendered" && choice !== "unrendered") {
  throw new Error("usage: select-review-base.mjs rendered|unrendered");
}

const workDir = process.cwd();
const source = path.join(workDir, `candidate-${choice}.md`);
const article = path.join(workDir, "article.md");
const validation = path.join(workDir, "validation.json");
const renderedValidation = path.join(workDir, "validation-rendered.json");
const unrenderedValidation = path.join(workDir, "validation-unrendered.json");
const selection = path.join(workDir, ".base-selection.json");
const renderedValidationSource = process.env.ARTICLE_REVIEW_RENDERED_VALIDATION_PATH;
const unrenderedValidationSource = process.env.ARTICLE_REVIEW_UNRENDERED_VALIDATION_PATH;

if (!renderedValidationSource || !unrenderedValidationSource) {
  throw new Error("candidate validator findings are unavailable");
}

await Promise.all([
  fs.access(source),
  fs.access(renderedValidationSource),
  fs.access(unrenderedValidationSource),
]);
try {
  await fs.access(selection);
  throw new Error("a review base has already been selected");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const temporary = path.join(workDir, `.article.${process.pid}.tmp`);
const temporaryRenderedValidation = path.join(workDir, `.validation-rendered.${process.pid}.tmp`);
const temporaryUnrenderedValidation = path.join(workDir, `.validation-unrendered.${process.pid}.tmp`);
await fs.copyFile(source, temporary, constants.COPYFILE_EXCL);
await Promise.all([
  fs.copyFile(renderedValidationSource, temporaryRenderedValidation, constants.COPYFILE_EXCL),
  fs.copyFile(unrenderedValidationSource, temporaryUnrenderedValidation, constants.COPYFILE_EXCL),
]);
try {
  await fs.rename(temporary, article);
  await fs.chmod(article, 0o600);
  await fs.rename(temporaryRenderedValidation, renderedValidation);
  await fs.rename(temporaryUnrenderedValidation, unrenderedValidation);
  await fs.copyFile(
    choice === "rendered" ? renderedValidation : unrenderedValidation,
    validation,
    constants.COPYFILE_EXCL,
  );
  await Promise.all([
    fs.chmod(validation, 0o400),
    fs.chmod(renderedValidation, 0o400),
    fs.chmod(unrenderedValidation, 0o400),
  ]);
  await fs.writeFile(selection, `${JSON.stringify({ base: choice })}\n`, { flag: "wx" });
  await fs.chmod(selection, 0o400);
} catch (error) {
  await fs.rm(temporary, { force: true });
  await fs.rm(temporaryRenderedValidation, { force: true });
  await fs.rm(temporaryUnrenderedValidation, { force: true });
  await fs.rm(article, { force: true });
  await fs.rm(validation, { force: true });
  await fs.rm(renderedValidation, { force: true });
  await fs.rm(unrenderedValidation, { force: true });
  throw error;
}

process.stdout.write(`Selected ${choice} candidate as article.md\n`);
