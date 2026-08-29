import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export const REVIEW_BASES = ["rendered", "unrendered"];

export async function selectReviewBase({
  workDir,
  base,
  renderedValidationSource,
  unrenderedValidationSource,
}) {
  if (!REVIEW_BASES.includes(base)) {
    throw new Error("review base must be rendered or unrendered");
  }
  if (!renderedValidationSource || !unrenderedValidationSource) {
    throw new Error("candidate validator findings are unavailable");
  }

  const source = path.join(workDir, `candidate-${base}.md`);
  const article = path.join(workDir, "article.md");
  const validation = path.join(workDir, "validation.json");
  const renderedValidation = path.join(workDir, "validation-rendered.json");
  const unrenderedValidation = path.join(workDir, "validation-unrendered.json");
  const selection = path.join(workDir, ".base-selection.json");

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
      base === "rendered" ? renderedValidation : unrenderedValidation,
      validation,
      constants.COPYFILE_EXCL,
    );
    await Promise.all([
      fs.chmod(validation, 0o400),
      fs.chmod(renderedValidation, 0o400),
      fs.chmod(unrenderedValidation, 0o400),
    ]);
    await fs.writeFile(selection, `${JSON.stringify({ base })}\n`, { flag: "wx" });
    await fs.chmod(selection, 0o400);
  } catch (error) {
    await Promise.all([
      fs.rm(temporary, { force: true }),
      fs.rm(temporaryRenderedValidation, { force: true }),
      fs.rm(temporaryUnrenderedValidation, { force: true }),
      fs.rm(article, { force: true }),
      fs.rm(validation, { force: true }),
      fs.rm(renderedValidation, { force: true }),
      fs.rm(unrenderedValidation, { force: true }),
    ]);
    throw error;
  }

  return { base };
}
