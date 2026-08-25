import {
  DOCUMENT_WORKER_LIMITS,
  digestDocumentWorkerRequirements,
  documentWorkerFail,
  validateDocumentCompileRequirements,
} from "./integration-document-worker-contract.js";

export const DOCUMENT_WORKER_SELF_CONTAINED_PROFILE = "self-contained-tex-v1";

const EXTERNAL_FILE_COMMAND = /\\(?:includegraphics\*?|includepdf|input|include|subfile|subfileinclude|lstinputlisting|verbatiminput|inputminted|bibliography|addbibresource|openin|read|write18|immediate\s*\\write18)\b/iu;
const EXTERNAL_PGF_COMMAND = /\\(?:pgfimage|pgfplotstableread|addplot3?)\b[^\r\n]{0,512}\b(?:file|graphics)\s*\{/iu;
const ENVIRONMENT_TOKEN = /\\(begin|end)\s*\{(figure\*?|tikzpicture|axis)\}/giu;
const FIGURE_DRAWING = /\\(?:rule|fbox|framebox|oval|line|vector|circle|qbezier|put|multiput|draw|path|fill|filldraw|shade|shadedraw|node|coordinate|clip|graph|addplot3?)\b|\\begin\s*\{(?:picture|tabular\*?|tabularx|array|pgfpicture)\}/iu;
const TIKZ_DRAWING = /\\(?:draw|path|fill|filldraw|shade|shadedraw|node|coordinate|clip|graph|matrix|foreach|pic|pattern|useasboundingbox)\b/iu;
const AXIS_DRAWING = /\\(?:addplot3?|legend|addlegendentry|node)\b/iu;

function stripComments(source) {
  const lines = source.split(/\r?\n/u);
  return lines.map((line) => {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== "%") continue;
      let slashes = 0;
      for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) slashes += 1;
      if (slashes % 2 === 0) return line.slice(0, index);
    }
    return line;
  }).join("\n");
}

function scrubLiteralEnvironments(source) {
  return source.replace(
    /\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}[\s\S]*?\\end\s*\{\1\}/gu,
    " "
  );
}

function parseRecognizedEnvironments(source) {
  const roots = [];
  const stack = [];
  const environmentToken = new RegExp(ENVIRONMENT_TOKEN.source, ENVIRONMENT_TOKEN.flags);
  let match;
  while ((match = environmentToken.exec(source)) !== null) {
    const action = match[1].toLowerCase();
    const environment = match[2].toLowerCase();
    if (action === "begin") {
      const node = {
        environment,
        bodyStart: environmentToken.lastIndex,
        bodyEnd: -1,
        children: [],
      };
      if (stack.length > 0) stack.at(-1).children.push(node);
      else roots.push(node);
      stack.push(node);
      continue;
    }
    const node = stack.pop();
    if (!node || node.environment !== environment) {
      documentWorkerFail(
        "TEX_REQUIREMENTS_UNSATISFIED",
        "Recognized TeX figure environments are not structurally balanced.",
        { status: 422 }
      );
    }
    node.bodyEnd = match.index;
  }
  if (stack.length > 0) {
    documentWorkerFail(
      "TEX_REQUIREMENTS_UNSATISFIED",
      "Recognized TeX figure environments are not structurally balanced.",
      { status: 422 }
    );
  }
  return roots;
}

function meaningfulNode(node, source) {
  const body = source.slice(node.bodyStart, node.bodyEnd);
  const childIsMeaningful = node.children.some((child) => meaningfulNode(child, source));
  if (node.environment === "figure" || node.environment === "figure*") {
    return childIsMeaningful || FIGURE_DRAWING.test(body);
  }
  if (node.environment === "tikzpicture") {
    return childIsMeaningful || TIKZ_DRAWING.test(body);
  }
  return childIsMeaningful || AXIS_DRAWING.test(body);
}

export function inspectIntegrationDocumentCompileRequirements(sourceValue, requirementsValue) {
  const requirements = validateDocumentCompileRequirements(requirementsValue);
  if (typeof sourceValue !== "string" || !sourceValue.isWellFormed()) {
    documentWorkerFail("INVALID_REQUEST", "TeX source is invalid.", { status: 400 });
  }
  const source = scrubLiteralEnvironments(stripComments(sourceValue));
  if (EXTERNAL_FILE_COMMAND.test(source) || EXTERNAL_PGF_COMMAND.test(source)) {
    documentWorkerFail(
      "TEX_EXTERNAL_ASSET_FORBIDDEN",
      "The self-contained TeX profile rejects external file and image assets.",
      { status: 422 }
    );
  }
  const roots = parseRecognizedEnvironments(source);
  const verifiedFigureCount = roots.filter((node) => meaningfulNode(node, source)).length;
  if (verifiedFigureCount > DOCUMENT_WORKER_LIMITS.maximumFigureCount) {
    documentWorkerFail("TEX_LIMIT_EXCEEDED", "The TeX figure count exceeds its bound.", { status: 422 });
  }
  if (verifiedFigureCount < requirements.minimumFigureCount) {
    documentWorkerFail(
      "TEX_REQUIREMENTS_UNSATISFIED",
      "The TeX source does not satisfy its required self-contained figure count.",
      { status: 422 }
    );
  }
  return Object.freeze({
    requirements,
    requirementsDigest: digestDocumentWorkerRequirements(requirements),
    verifiedFigureCount,
  });
}
