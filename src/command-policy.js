import path from "node:path";
import {
  hasActiveShellCommandSubstitution,
  hasActiveShellExpansion,
  parseTopLevelShellSequence,
  tokenizeShellWords,
} from "./shell-syntax.js";

export const SANDBOX_MODES = ["host", "docker-readonly", "docker-workspace"];
export const PACKAGE_INSTALL_POLICIES = ["block", "prompt", "allow"];

const READ_ONLY_PATTERNS = [
  /^pwd$/,
  /^date$/,
  /^whoami$/,
  /^which\s+[-\w.]+(?:\s+[-\w.]+)*$/,
  /^command\s+-v\s+[-\w.]+$/,
  /^uname(?:\s+-a)?$/,
  /^ls(?:\s+(?:"[^"\n]*"|'[^'\n]*'|[-\w./~*]+))*$/,
  /^find(?:\s+[./~\w-]+)*(?:\s+-maxdepth\s+\d+)?(?:\s+-type\s+[fd])?$/,
  /^rg(?:\s+.+)?$/,
  /^grep(?:\s+.+)?$/,
  /^cat(?:\s+[-\w./~*]+)+$/,
  /^head(?:\s+.+)?$/,
  /^tail(?:\s+.+)?$/,
  /^sort(?:\s+[-\w./~*]+)*$/,
  /^wc(?:\s+.+)?$/,
  /^file(?:\s+[-\w./~*]+)+$/,
  /^stat(?:\s+[-\w./~*]+)+$/,
  /^sha256sum(?:\s+[-\w./~*]+)+$/,
  /^sed\s+-n\s+['"0-9,:p\s-]+(?:\s+[-\w./~*]+)?$/,
  /^git\s+(status|branch|log|show|diff(?:\s+--stat)?|remote\s+-v)(?:\s+.+)?$/,
  /^git\s+rev-parse(?:\s+(?:--show-toplevel|--git-dir|--is-inside-work-tree|--show-prefix|--show-cdup|--abbrev-ref|--verify|--short(?:=\d+)?|[-\w./@^{}~:]+))+$/,
  /^git\s+ls-files(?:\s+(?:--(?:cached|deleted|modified|others|ignored|stage|unmerged|exclude-standard)|[-\w./*]+))*$/,
  /^node\s+(?:-v|--version)$/,
  /^node\s+[-\w./]+\.(?:c?js|mjs)\s+(?:--help|help|doctor|status|health)(?:\s+[-\w./:=]+)*$/,
  /^npm\s+(?:-v|--version)$/,
  /^python(?:3(?:\.\d+)*)?\s+--version$/,
  /^(?:[-/\w.]+\/)?python(?:3(?:\.\d+)*)?\s+[-\w./]+\.py\s+(?:--help|help|doctor|status|health)(?:\s+[-\w./:=]+)*$/,
  /^python(?:3(?:\.\d+)*)?\s+-m\s+json\.tool$/,
  /^pip(?:3)?\s+--version$/,
  /^conda\s+--version$/,
  /^R\s+--version$/,
  /^Rscript\s+--version$/,
  /^(?:[-/\w.]+\/)?java\s+-version$/,
  /^(?:[-/\w.]+\/)?gradle\s+--version$/,
  /^(?:[-/\w.]+\/)?adb\s+devices(?:\s+-l)?$/,
  /^(?:[-/\w.]+\/)?emulator\s+-list-avds$/,
  /^(?:[-/\w.]+\/)?sdkmanager\s+--list(?:\s+[-\w./:=]+)*$/,
  /^(?:pdflatex|latexmk)\s+--version$/,
  /^(?:(?:[-/\w.]+\/)?python(?:3)?\s+)?[-\w./]*xyq_cdp_browser\.py\s+--cdp-url\s+(?:"[^"\n]+"|'[^'\n]+'|[-\w./:@]+)\s+list-pages$/,
  /^test\s+-[efdx]\s+[-\w./~]+$/,
  /^true$/,
  /^false$/,
  /^echo(?:\s+.+)?$/,
];

// Keep direct Python test recognition structural and bounded. Interpreter
// runtime flags are separate from the script path so common invocations do
// not fall through to trusted general-shell policy.
const PYTHON_TEST_EXECUTABLE_PATTERN = String.raw`(?:[-/\\\w.]+[/\\])?python(?:3(?:\.\d+)*)?`;
const PYTHON_TEST_FLAGS_PATTERN = String.raw`(?:(?:-(?:B|E|I|O|OO|P|q|s|S|u|v|x)|-(?:X|W)\s+[-\w.:=,]+)\s+)*`;
const PYTHON_TEST_TARGET_PATTERN = String.raw`(?:[-\w./\\]*[/\\])?(?:test_[\w.-]+|[\w.-]+_test)\.py`;
const PYTHON_TEST_ARGUMENTS_PATTERN = String.raw`(?:\s+[-\w./\\:=@]+)*`;
const PYTHON_TEST_SCRIPT_PATTERNS = [
  new RegExp(
    `^${PYTHON_TEST_EXECUTABLE_PATTERN}\\s+${PYTHON_TEST_FLAGS_PATTERN}${PYTHON_TEST_TARGET_PATTERN}${PYTHON_TEST_ARGUMENTS_PATTERN}$`
  ),
];

function stripBenignRedirections(command = "") {
  return String(command || "")
    .replace(/\s+2>&1\b/g, "")
    .replace(/\s+1>&2\b/g, "")
    .replace(/\s+2>\/dev\/null\b/g, "")
    .replace(/\s+1>\/dev\/null\b/g, "")
    .replace(/\s+>\/dev\/null\b/g, "")
    .trim();
}

function isReadOnlyPrintfCommand(command = "") {
  const normalized = stripBenignRedirections(command);
  if (!/^printf(?:\s|$)/.test(normalized) || hasActiveShellExpansion(normalized)) return false;
  const tokens = tokenizeShellWords(normalized);
  if (!tokens.length || tokens[0] !== "printf") return false;
  // Bash's `printf -v name ...` mutates shell state and can influence a later
  // command. Ordinary printf writes only to stdout and is safe once expansion
  // and redirection checks have passed.
  return !tokens.slice(1).some((token) => token === "-v" || /^-v[A-Za-z_]/.test(token));
}

function isReadOnlyTrDeleteFilter(command = "") {
  const normalized = stripBenignRedirections(command);
  if (hasActiveShellExpansion(normalized)) return false;
  const tokens = tokenizeShellWords(normalized);
  return tokens.length === 3 && tokens[0] === "tr" && tokens[1] === "-d";
}

function isReadOnlySha256Command(command = "") {
  const normalized = stripBenignRedirections(command);
  if (hasActiveShellExpansion(normalized)) return false;
  const tokens = tokenizeShellWords(normalized);
  if (tokens[0] !== "sha256sum" || tokens.length < 2) return false;
  const paths = tokens.slice(1).filter((token) => token !== "--");
  return paths.length > 0 && paths.every((token) =>
    !token.startsWith("-") && READ_ONLY_FOR_LOOP_LITERAL_PATTERN.test(token)
  );
}

function isReadOnlyFindCommand(command = "") {
  const normalized = stripBenignRedirections(command);
  if (!/^find\s+/.test(normalized)) return false;
  if (/(^|\s)(-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprintf|-fls)\b/.test(normalized)) return false;
  const unquoted = stripQuotedSegments(normalized);
  if (/[|<>;&`$]/.test(unquoted)) return false;
  return /^find\s+(?:[-./~\w]+|\/workspace)(?:\s+[-\w]+(?:\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s|<>;&`$]+))?)*$/.test(normalized);
}

function isUnboundedRecursiveGrep(command = "") {
  const normalized = stripBenignRedirections(command);
  if (!/^grep\s+/.test(normalized)) return false;
  return /(?:^|\s)--(?:recursive|dereference-recursive)(?:\s|=|$)/.test(normalized) ||
    /(?:^|\s)-[A-Za-z]*[rR][A-Za-z]*(?:\s|$)/.test(normalized);
}

const TEST_PATTERNS = [
  /^npm\s+run\s+(?:check|test|build|lint|smoke)(?::[-\w.]+)*(?:\s+--(?:\s+[-\w./:=@]+)*)?$/,
  /^npm\s+--prefix\s+[-\w./]+\s+run\s+(?:check|test|build|lint|smoke)(?::[-\w.]+)*(?:\s+--(?:\s+[-\w./:=@]+)*)?$/,
  /^npm\s+(?:check|test|build|lint)(?:\s+--(?:\s+[-\w./:=@]+)*)?$/,
  /^npm\s+--prefix\s+[-\w./]+\s+(?:check|test|build|lint)(?:\s+--(?:\s+[-\w./:=@]+)*)?$/,
  /^(?:pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s+[-\w./:=@]+)*$/,
  /^(?:cargo|go|dotnet)\s+test(?:\s+[-\w./:=@]+)*$/,
  /^(?:mvnw?|gradlew?|\.\/(?:mvnw|gradlew))\s+test(?:\s+[-\w./:=@]+)*$/,
  /^ctest(?:\s+[-\w./:=@]+)*$/,
  /^make\s+(?:test|check)(?:\s+[-\w./:=@]+)*$/,
  /^node\s+--check\s+[-\w./]+$/,
  /^bash\s+-n\s+[-\w./]+\.sh$/,
  /^sh\s+-n\s+[-\w./]+\.sh$/,
  /^python(?:3(?:\.\d+)*)?\s+-m\s+py_compile\s+[-\w./]+\.py$/,
  /^python(?:3(?:\.\d+)*)?\s+-m\s+unittest(?:\s+[-\w./:=]+)*$/,
  /^python(?:3(?:\.\d+)*)?\s+-m\s+pytest(?:\s+[-\w./:=]+)*$/,
  /^pytest(?:\s+[-\w./:=]+)*$/,
  ...PYTHON_TEST_SCRIPT_PATTERNS,
];

// TEST_PATTERNS is the broader allowlist for validation commands. Only these
// commands prove that project tests actually ran; build, lint, and syntax
// checks remain useful validation without satisfying the test contract.
const SUBSTANTIVE_TEST_PATTERNS = [
  /^npm\s+(?:--prefix\s+[-\w./]+\s+)?run\s+(?:test|smoke)(?::[-\w.]+)*(?:\s+--(?:\s+[-\w./:=@]+)*)?$/,
  /^npm\s+(?:--prefix\s+[-\w./]+\s+)?test(?:\s+--(?:\s+[-\w./:=@]+)*)?$/,
  /^(?:pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s+[-\w./:=@]+)*$/,
  /^(?:cargo|go|dotnet)\s+test(?:\s+[-\w./:=@]+)*$/,
  /^(?:mvnw?|gradlew?|\.\/(?:mvnw|gradlew))\s+test(?:\s+[-\w./:=@]+)*$/,
  /^ctest(?:\s+[-\w./:=@]+)*$/,
  /^make\s+(?:test|check)(?:\s+[-\w./:=@]+)*$/,
  /^python(?:3(?:\.\d+)*)?\s+-m\s+unittest(?:\s+[-\w./:=]+)*$/,
  /^python(?:3(?:\.\d+)*)?\s+-m\s+pytest(?:\s+[-\w./:=]+)*$/,
  /^pytest(?:\s+[-\w./:=]+)*$/,
  ...PYTHON_TEST_SCRIPT_PATTERNS,
];

function commandHasOption(args = [], names = []) {
  const accepted = new Set(names.map((name) => String(name).toLowerCase()));
  return args.some((token) => {
    const option = String(token || "").toLowerCase();
    if (accepted.has(option)) return true;
    const equals = option.indexOf("=");
    return equals > 0 && accepted.has(option.slice(0, equals));
  });
}

function testInvocationIsInformational(tokens = []) {
  return commandHasOption(tokens, ["-h", "--help", "--version"]);
}

function optionPathValues(args = [], names = []) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || "");
    for (const name of names) {
      if (token === name) {
        if (args[index + 1]) values.push(String(args[index + 1]));
        continue;
      }
      if (token.startsWith(`${name}=`) || token.startsWith(`${name}:`)) {
        values.push(token.slice(name.length + 1));
        continue;
      }
      if (/^-[A-Za-z]$/.test(name) && token.startsWith(name) && token.length > name.length) {
        values.push(token.slice(name.length).replace(/^=/, ""));
      }
    }
  }
  return values.filter(Boolean);
}

function delegatedPathIsOutsideWorkspace(value = "") {
  const candidate = String(value || "").trim().replace(/\\/g, "/");
  if (!candidate) return false;
  if (/^[A-Za-z]:\//.test(candidate) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate)) {
    return true;
  }
  const relativeCandidate = candidate.replace(/^(?:\.\/)+/, "");
  return (
    !isSafeWorkspacePath(relativeCandidate) &&
    !isSafeVirtualWorkspaceDir(candidate)
  );
}

function validationExecutablePathMetadata(value = "") {
  const candidate = String(value || "").trim().replace(/\\/g, "/");
  if (!candidate || !candidate.includes("/")) {
    return { outsideWorkspace: false, virtualWorkspacePath: false };
  }
  if (/^[A-Za-z]:\//.test(candidate) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate)) {
    return { outsideWorkspace: true, virtualWorkspacePath: false };
  }
  if (isSafeVirtualWorkspacePath(candidate)) {
    return { outsideWorkspace: false, virtualWorkspacePath: true };
  }
  const relativeCandidate = candidate.replace(/^(?:\.\/)+/, "");
  return {
    outsideWorkspace: !isSafeRelativeDir(relativeCandidate),
    virtualWorkspacePath: false,
  };
}

function externalRunnerPlanPaths(executable = "", args = []) {
  const optionNames = {
    cargo: ["--manifest-path"],
    ctest: ["--test-dir"],
    dotnet: ["--settings", "--test-adapter-path"],
    gradle: ["-b", "--build-file", "-c", "--settings-file", "-p", "--project-dir", "-I", "--init-script", "--include-build"],
    gradlew: ["-b", "--build-file", "-c", "--settings-file", "-p", "--project-dir", "-I", "--init-script", "--include-build"],
    mvn: ["-f", "--file"],
    mvnw: ["-f", "--file"],
  };
  const paths = optionPathValues(args, optionNames[executable] || []);
  if (["dotnet", "go"].includes(executable)) {
    const testIndex = args.findIndex((token) => String(token).toLowerCase() === "test");
    if (testIndex >= 0) {
      paths.push(
        ...args.slice(testIndex + 1).filter((token) => {
          const candidate = String(token || "").replace(/\\/g, "/");
          return (
            candidate.startsWith("/") ||
            candidate.startsWith("~/") ||
            candidate === ".." ||
            candidate.startsWith("../") ||
            /^[A-Za-z]:\//.test(candidate)
          );
        })
      );
    }
  }
  return paths.filter(delegatedPathIsOutsideWorkspace);
}

function delegatedValidationPlanClassification(tokens = []) {
  if (!Array.isArray(tokens) || !tokens.length) return null;
  const executable = String(tokens[0] || "").split(/[/\\]/).at(-1)?.toLowerCase();
  const args = tokens.slice(1).map((token) => String(token || ""));
  const executablePath = validationExecutablePathMetadata(tokens[0]);
  const basenameCommand = [executable, ...args].join(" ");
  const validationLike = Boolean(
    structuredValidationCommand(basenameCommand) || matchAny(TEST_PATTERNS, basenameCommand)
  );
  if (executablePath.outsideWorkspace && validationLike) {
    return {
      category: "general-shell",
      needsNetwork: true,
      writesWorkspace: true,
      mayMutateProject: true,
      substantiveTest: false,
      reason:
        "The validation executable is outside the current workspace and requires trusted shell policy.",
    };
  }
  const externalPlanPaths = externalRunnerPlanPaths(executable, args);
  if (externalPlanPaths.length) {
    return {
      category: "general-shell",
      needsNetwork: true,
      writesWorkspace: true,
      mayMutateProject: true,
      substantiveTest: false,
      reason:
        "The validation runner delegates its project or execution plan outside the current workspace and requires trusted shell policy.",
    };
  }
  if (/^(?:g|mingw32-)?make$/.test(executable)) {
    const hasEvalOption = args.some((token) =>
      token === "-E" || /^-E.+/.test(token) || token === "--eval" || token.startsWith("--eval=")
    );
    const hasMakeExpansion = args.some((token) => /\$[({]/.test(token));
    if (hasEvalOption || hasMakeExpansion) {
      return {
        category: "blocked",
        hardBlocked: true,
        needsNetwork: true,
        writesWorkspace: true,
        mayMutateProject: true,
        reason:
          "The validation runner received interpreter-owned evaluation syntax that can execute undeclared commands.",
      };
    }
    const delegatesToExternalPlan = args.some((token) =>
      /^(?:-f(?:.+|$)|--(?:file|makefile)(?:=|$)|-C(?:.+|$)|--directory(?:=|$)|-I(?:.+|$)|--include-dir(?:=|$))/.test(token)
    );
    if (delegatesToExternalPlan) {
      return {
        category: "general-shell",
        needsNetwork: true,
        writesWorkspace: true,
        mayMutateProject: true,
        substantiveTest: false,
        reason:
          "The validation runner delegates its execution plan to another file or directory and requires trusted shell policy.",
      };
    }
  }
  if (executable === "ctest") {
    const delegatesToExternalPlan = args.some((token) =>
      /^(?:-S(?:.+|$)|--script(?:-new-process)?(?:=|$)|-D(?:.+|$)|--dashboard(?:=|$)|-M(?:.+|$)|--test-model(?:=|$)|-T(?:.+|$)|--test-action(?:=|$)|--build-and-test(?:=|$)|--build-(?:generator|project|target|config|options)(?:=|$)|--test-command(?:=|$))/.test(
        token
      )
    );
    if (delegatesToExternalPlan) {
      return {
        category: "general-shell",
        needsNetwork: true,
        writesWorkspace: true,
        mayMutateProject: true,
        substantiveTest: false,
        reason:
          "CTest script, dashboard, and build-and-test modes execute a delegated plan and require trusted shell policy.",
      };
    }
  }
  return null;
}

function validationCommandDeclaresOutput(tokens = []) {
  let executable = String(tokens[0] || "").split(/[/\\]/).at(-1)?.toLowerCase();
  let args = tokens.slice(1);
  if (/^python(?:3(?:\.\d+)*)?$/.test(executable) && args[0] === "-m") {
    executable = String(args[1] || "").toLowerCase();
    args = args.slice(2);
  }
  if (
    executable === "node" &&
    commandHasOption(args, ["--test-reporter-destination"])
  ) {
    return true;
  }
  if (executable === "go" && args[0] === "test") {
    return commandHasOption(args.slice(1), [
      "-blockprofile",
      "-coverprofile",
      "-cpuprofile",
      "-memprofile",
      "-mutexprofile",
      "-o",
      "-trace",
    ]);
  }
  if (executable === "ctest" && commandHasOption(args, ["--output-junit"])) return true;
  if (
    ["pytest", "py.test"].includes(executable) &&
    commandHasOption(args, ["--html", "--junit-xml", "--junitxml"])
  ) {
    return true;
  }
  if (
    /^python(?:3(?:\.\d+)*)?$/.test(executable) &&
    /\.py$/i.test(String(args[0] || "")) &&
    commandHasOption(args.slice(1), [
      "-o",
      "--output",
      "--output-dir",
      "--output-directory",
      "--output-file",
      "--report-file",
      "--save",
    ])
  ) {
    return true;
  }
  return false;
}

function validationCommandMayMutateProject(command = "") {
  const normalized = String(command || "").trim();
  if (!normalized) return false;
  const tokens = tokenizeShellWords(normalized);
  if (validationCommandDeclaresOutput(tokens)) return true;
  const packageScript = packageManagerScriptName(tokens);
  if (packageScript && packageScriptMayMutate(packageScript)) return true;
  if (/(?:^|\s)--(?:fix|write)(?:\s|=|$)/i.test(normalized)) {
    return true;
  }
  if (
    /(?:^|\s)(?:--(?:update-?snapshots?|snapshot-?update|test-update-snapshots?)|--coverage|--coverageDirectory)(?:\s|=|$)/i.test(
      normalized
    ) ||
    (/^(?:npm|pnpm|yarn|bun|node)\b/.test(normalized) && /(?:^|\s)-u(?:\s|=|$)/.test(normalized))
  ) {
    return true;
  }
  if (/\bpy_compile\b/.test(normalized)) return true;
  if (
    String(tokens[0] || "").split(/[/\\]/).at(-1)?.toLowerCase() === "go" &&
    tokens[1] === "test" &&
    commandHasOption(tokens.slice(2), ["-c"])
  ) {
    return true;
  }
  return /^(?:cargo|dotnet)\s+test\b|^(?:mvnw?|gradlew?|\.\/(?:mvnw|gradlew))\s+test\b/.test(
    normalized
  );
}

function packageManagerScriptName(tokens = []) {
  if (!Array.isArray(tokens) || !tokens.length) return "";
  const manager = String(tokens[0] || "").split(/[/\\]/).at(-1)?.toLowerCase();
  if (!["npm", "pnpm", "yarn", "bun"].includes(manager)) return "";
  let index = 1;
  if (manager === "npm" && tokens[index] === "--prefix") index += 2;
  if (tokens[index] === "run") index += 1;
  return String(tokens[index] || "").toLowerCase();
}

function invokesPackageManagerScript(tokens = []) {
  if (!Array.isArray(tokens) || !tokens.length) return false;
  const manager = String(tokens[0] || "").split(/[/\\]/).at(-1)?.toLowerCase();
  if (!["npm", "pnpm", "yarn", "bun"].includes(manager)) return false;
  let index = 1;
  if (manager === "npm" && tokens[index] === "--prefix") index += 2;
  if (tokens[index] === "run") return Boolean(tokens[index + 1]);
  return /^(?:build|check|lint|smoke|test)(?::|$)/.test(String(tokens[index] || "").toLowerCase());
}

function packageScriptHasUnsafeLifecycle(scriptName = "") {
  const segments = String(scriptName || "").toLowerCase().split(":").filter(Boolean);
  return segments.some((segment) =>
    /^(?:(?:pre|post)?(?:publish(?:only)?|pack|deploy|release|upload|submit|token|login|logout|adduser|auth|install|uninstall|bootstrap|setup|upgrade)(?:[-_.]|$)|prepare(?:[-_.]|$)|dependencies(?:[-_.]|$)|(?:add|remove|update)[-_.]?(?:deps?|dependencies|packages?)(?:[-_.]|$))/.test(
      segment
    )
  );
}

function packageScriptMayMutate(scriptName = "") {
  const segments = String(scriptName || "").toLowerCase().split(":").filter(Boolean);
  if (!segments.length) return false;
  if (segments[0] === "build") return true;
  return segments.slice(1).some((segment) =>
    /^(?:build|compile|coverage|fix|format|generate|regen(?:erate)?|update(?:[-_.]?snapshots?)?|write)(?:[-_.]|$)/.test(
      segment
    )
  );
}

function boundedTestArguments(tokens = []) {
  return (
    Array.isArray(tokens) &&
    tokens.every((token) => {
      const text = String(token || "");
      return text.length > 0 && text.length <= 512 && !/[\r\n\0]/.test(text);
    })
  );
}

function nodeTestTargetIsExplicitTest(value = "") {
  const raw = String(value || "").replace(/\\/g, "/");
  if (!raw || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return false;
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === ".." || normalized.startsWith("../")) return false;
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(normalized)) return true;
  const basename = normalized.split("/").at(-1) || "";
  return /(?:^|[._-])(?:test|spec)(?:[._-]|$)/i.test(basename);
}

function nodeTestUsesExecutableModuleHook(args = []) {
  return args.some((token) =>
    /^(?:-r(?:=|[^-].*)?|--(?:require|import|loader|experimental-loader|test-global-setup|test-reporter)(?:=|$))/i.test(
      String(token || "")
    )
  );
}

const NODE_OPTIONS_WITH_SEPARATE_VALUE = new Set([
  "-r",
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--experimental-loader",
  "--import",
  "--input-type",
  "--loader",
  "--require",
  "--test-concurrency",
  "--test-coverage-branches",
  "--test-coverage-exclude",
  "--test-coverage-functions",
  "--test-coverage-include",
  "--test-coverage-lines",
  "--test-global-setup",
  "--test-isolation",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-rerun-failures",
  "--test-shard",
  "--test-skip-pattern",
  "--test-timeout",
]);

function nodeCliPositionals(args = []) {
  const positionals = [];
  let literalArguments = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || "");
    if (!literalArguments && token === "--") {
      literalArguments = true;
      continue;
    }
    if (!literalArguments && token.startsWith("-")) {
      const option = token.split("=", 1)[0];
      if (!token.includes("=") && NODE_OPTIONS_WITH_SEPARATE_VALUE.has(option)) index += 1;
      continue;
    }
    positionals.push({ index, value: token });
  }
  return positionals;
}

function nativeTestRunnerExecutesTests(executable = "", args = []) {
  const runner = String(executable || "").toLowerCase();
  const options = args.slice(1);
  if (runner === "cargo" && commandHasOption(options, ["--no-run", "--list"])) return false;
  if (runner === "go" && commandHasOption(options, ["-c", "-list"])) return false;
  if (runner === "dotnet" && commandHasOption(options, ["-t", "--list-tests"])) return false;
  if (runner === "ctest" && commandHasOption(args, ["-n", "--show-only", "--print-labels"])) {
    return false;
  }
  if (["gradle", "gradlew"].includes(runner)) {
    if (commandHasOption(options, ["-m", "--dry-run", "--task-graph"])) return false;
    for (let index = 0; index < options.length; index += 1) {
      const token = String(options[index] || "").toLowerCase();
      if (
        ["-x", "--exclude-task"].includes(token) &&
        String(options[index + 1] || "").toLowerCase() === "test"
      ) {
        return false;
      }
      if (/^(?:-x|--exclude-task)=test$/.test(token)) return false;
    }
  }
  if (["mvn", "mvnw"].includes(runner)) {
    if (options.some((token) => /^-d(?:skiptests|maven\.test\.skip)(?:=true)?$/i.test(String(token)))) {
      return false;
    }
  }
  if (runner === "make" && commandHasOption(args, ["-n", "-q", "-t", "--dry-run", "--just-print", "--question", "--recon", "--touch"])) {
    return false;
  }
  return true;
}

function structuredNativeTestRunner(tokens = [], command = "") {
  const executable = String(tokens[0] || "").split(/[/\\]/).at(-1)?.toLowerCase();
  const args = tokens.slice(1);
  const directTestSubcommand = new Set(["cargo", "dotnet", "go", "gradle", "gradlew", "mvn", "mvnw"]);
  const directTestTarget = directTestSubcommand.has(executable) && args[0] === "test";
  const ctestInvocation = executable === "ctest";
  const makeTestTarget = executable === "make" && ["check", "test"].includes(args[0]);
  if (!directTestTarget && !ctestInvocation && !makeTestTarget) return null;
  return {
    substantiveTest: nativeTestRunnerExecutesTests(executable, args),
    mayMutateProject: validationCommandMayMutateProject(command),
  };
}

function structuredPythonValidationScript(tokens = [], command = "") {
  const executable = String(tokens[0] || "").split(/[/\\]/).at(-1)?.toLowerCase();
  if (!/^python(?:3(?:\.\d+)*)?$/.test(executable)) return null;
  let index = 1;
  while (index < tokens.length && String(tokens[index] || "").startsWith("-")) {
    const option = String(tokens[index] || "");
    if (/^-(?:B|E|I|O|OO|P|q|s|S|u|v|x)$/.test(option)) {
      index += 1;
      continue;
    }
    if (/^-(?:W|X)$/.test(option) && tokens[index + 1]) {
      index += 2;
      continue;
    }
    if (/^-(?:W|X).+/.test(option)) {
      index += 1;
      continue;
    }
    return null;
  }
  const script = String(tokens[index] || "").replace(/\\/g, "/");
  if (!/\.py$/i.test(script)) return null;
  const basename = script.toLowerCase().split("/").filter(Boolean).at(-1) || "";
  const validationBasename =
    /(?:^|[._-])(?:acceptance|audit|check|contract|spec|test|validat(?:e|ion)?|verif(?:y|ication))(?:[._-]|$)/.test(
      basename.replace(/\.py$/i, "")
    );
  if (!validationBasename) return null;
  return {
    substantiveTest: true,
    mayMutateProject: validationCommandMayMutateProject(command),
  };
}

function structuredValidationCommand(command = "") {
  const shellSequence = parseTopLevelShellSequence(command);
  if (
    shellSequence.commands.length !== 1 ||
    shellSequence.separators.length > 0 ||
    shellSequence.trailingSeparator
  ) {
    return null;
  }
  if (hasActiveShellExpansion(command)) return null;
  const tokens = tokenizeShellWords(command);
  if (!boundedTestArguments(tokens)) return null;
  const executable = String(tokens[0] || "").split(/[/\\]/).at(-1)?.toLowerCase();

  const pythonValidationScript = structuredPythonValidationScript(tokens, command);
  if (pythonValidationScript) return pythonValidationScript;

  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    const scriptName = packageManagerScriptName(tokens);
    if (!/^(?:build|check|lint|smoke|test)(?::[-\w.]+)*$/.test(scriptName)) return null;
    return {
      substantiveTest: /^(?:smoke|test)(?::|$)/.test(scriptName),
      mayMutateProject: validationCommandMayMutateProject(command),
    };
  }

  let framework = executable;
  let args = tokens.slice(1);
  if (/^python(?:3(?:\.\d+)*)?$/.test(executable) && tokens[1] === "-m") {
    framework = String(tokens[2] || "").toLowerCase();
    args = tokens.slice(3);
  }
  if (framework === "pytest") {
    const collectionOnly = args.some((token) =>
      /^(?:--collect-only|--collectonly|--co)(?:=|$)/.test(String(token || ""))
    );
    return {
      substantiveTest: !collectionOnly,
      mayMutateProject: validationCommandMayMutateProject(command),
    };
  }
  if (framework === "unittest") {
    return {
      substantiveTest: !commandHasOption(args, ["--list-tests", "--collect-only"]),
      mayMutateProject: validationCommandMayMutateProject(command),
    };
  }

  const nativeRunner = structuredNativeTestRunner(tokens, command);
  if (nativeRunner) return nativeRunner;

  if (executable === "node" && args.includes("--test")) {
    const testIndex = args.indexOf("--test");
    const informationalMode = args.some((token) =>
      /^(?:-h|--help|-v|--version)(?:=|$)/.test(String(token || ""))
    );
    const evaluatesSource = args.some((token) =>
      /^(?:-e(?:[^-].*)?|--eval(?:=.*)?|-p(?:[^-].*)?|--print(?:=.*)?|-c|--check)$/.test(
        String(token || "")
      )
    );
    const positionals = nodeCliPositionals(args);
    const entrypointBeforeTest = positionals.some((item) => item.index < testIndex);
    if (informationalMode || evaluatesSource || entrypointBeforeTest) return null;
    const explicitTargets = positionals
      .filter((item) => item.index > testIndex)
      .map((item) => item.value);
    if (explicitTargets.some((target) => !nodeTestTargetIsExplicitTest(target))) return null;
    return {
      substantiveTest: true,
      mayMutateProject:
        validationCommandMayMutateProject(command) ||
        nodeTestUsesExecutableModuleHook(args),
    };
  }

  return null;
}

function classifyBackgroundShell(normalized = "") {
  const sequence = parseTopLevelShellSequence(normalized);
  if (!sequence.separators.includes("&") && sequence.trailingSeparator !== "&") return null;

  const classifications = sequence.commands.map((command) => classifySimpleCommand(command));
  const blocked = classifications.find((classification) => classification.category === "blocked");
  if (blocked) return { ...blocked, gitOnly: false, background: true };
  const destructive = classifications.find(
    (classification) => classification.category === "destructive"
  );
  if (destructive) return { ...destructive, gitOnly: false, background: true };

  return {
    category: "general-shell",
    needsNetwork: classifications.some((classification) => classification.needsNetwork),
    writesWorkspace: true,
    mayMutateProject: true,
    substantiveTest: false,
    background: true,
    reason:
      "Background shell execution is asynchronous and cannot provide bounded mutation or completion evidence.",
  };
}

const SAFE_WORKSPACE_WRITE_PATTERNS = [/^mkdir\s+-p\s+[-\w./]+$/];
const PERMISSION_CHANGE_PATTERNS = [/^(?:sudo\s+)?chmod\s+[-+=,rwxugoXst0-7]+\s+[-\w./]+$/];
const SAFE_ENV_ASSIGNMENT_NAMES = new Set(["ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME", "GRADLE_USER_HOME", "PATH"]);
const SAFE_ENV_VALUE_PATTERN = /^[-\w./:@+,%]+$/;

const NETWORK_FETCH_PATTERNS = [
  /^curl\b(?=[\s\S]*https?:\/\/\S+)[\s\S]*$/,
  /^wget\b(?=[\s\S]*https?:\/\/\S+)[\s\S]*$/,
];

function outputDestinationWritesFile(value = "") {
  const destination = String(value || "").trim();
  return Boolean(destination && destination !== "-" && !/^(?:\/dev\/null|nul)$/i.test(destination));
}

function networkFetchWritesWorkspace(command = "") {
  const tokens = tokenizeShellWords(command);
  const executable = path.basename(String(tokens[0] || "")).toLowerCase();
  if (executable === "curl") {
    for (let index = 1; index < tokens.length; index += 1) {
      const token = String(tokens[index] || "");
      if (["-O", "--remote-name", "--remote-name-all"].includes(token)) return true;
      if (token === "-o" || token === "--output") {
        if (outputDestinationWritesFile(tokens[index + 1])) return true;
        index += 1;
        continue;
      }
      if (token.startsWith("--output=")) {
        if (outputDestinationWritesFile(token.slice("--output=".length))) return true;
        continue;
      }
      if (/^-[^-]/.test(token)) {
        const outputIndex = token.indexOf("o", 1);
        if (outputIndex >= 1) {
          const inlineDestination = token.slice(outputIndex + 1);
          if (outputDestinationWritesFile(inlineDestination || tokens[index + 1])) return true;
          if (!inlineDestination) index += 1;
          continue;
        }
        if (token.includes("O")) return true;
      }
    }
    return false;
  }
  if (executable === "wget") {
    if (tokens.some((token) => token === "--spider")) return false;
    let explicitDestination;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = String(tokens[index] || "");
      if (token === "-O" || token === "--output-document") {
        explicitDestination = tokens[index + 1];
        index += 1;
        continue;
      }
      if (token.startsWith("--output-document=")) {
        explicitDestination = token.slice("--output-document=".length);
        continue;
      }
      if (/^-[^-]/.test(token)) {
        const outputIndex = token.indexOf("O", 1);
        if (outputIndex >= 1) {
          explicitDestination = token.slice(outputIndex + 1) || tokens[index + 1];
          if (!token.slice(outputIndex + 1)) index += 1;
        }
      }
    }
    if (explicitDestination !== undefined) return outputDestinationWritesFile(explicitDestination);
    // Unlike curl, wget writes its URL-derived filename unless explicitly sent
    // to stdout or used in spider mode.
    return true;
  }
  return false;
}

const GIT_WORKFLOW_PATTERNS = [
  /^git\s+init(?:\s+(?:\.|[-\w./]+))?$/,
  /^git\s+config(?:\s+--local)?\s+user\.(?:name|email)\s+(['"])[^'"\n]{1,160}\1$/,
  /^git\s+config(?:\s+--local)?\s+init\.defaultBranch\s+(?:main|master|trunk|develop)$/,
  /^git\s+add(?:\s+[-\w./*]+)+$/,
  /^git\s+add\s+-A$/,
  /^git\s+commit\s+(?:(?:-a|--allow-empty)\s+)*-m\s+(['"])[^'"\n]{1,220}\1$/,
  /^git\s+branch\s+-M\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+branch\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+switch\s+(?:-c\s+)?[A-Za-z0-9][-\w./]*$/,
  /^git\s+checkout\s+-b\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+checkout\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+merge\s+--ff-only\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+merge\s+--no-ff\s+--no-edit\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+merge\s+--no-ff\s+[A-Za-z0-9][-\w./]*\s+--no-edit$/,
  /^git\s+merge\s+--no-edit\s+--no-ff\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+merge\s+[A-Za-z0-9][-\w./]*\s+--no-ff\s+--no-edit$/,
  /^git\s+merge\s+[A-Za-z0-9][-\w./]*\s+--no-edit\s+--no-ff$/,
  /^git\s+fetch(?:\s+[-\w./:=]+)*$/,
  /^git\s+pull\s+--ff-only(?:\s+[-\w./:=]+)*$/,
  /^git\s+push(?:\s+[-\w./:=]+)*$/,
  /^git\s+tag\s+[A-Za-z0-9][-\w./]*$/,
  /^git\s+tag\s+-a\s+[A-Za-z0-9][-\w./]*\s+-m\s+(['"])[^'"\n]{1,220}\1$/,
];

const UNSAFE_GIT_PATTERNS = [
  /^git\s+pull\b(?!\s+--ff-only(?:\s|$))/,
  /^git\s+(merge|rebase|reset|checkout|switch|clean|restore)\b/,
];

const TOOLCHAIN_PATTERNS = [
  /^(?:[-/\w.]+\/)?python(?:3(?:\.\d+)*)?\s+[-\w./]+\.py(?:\s+[-\w./:=]+)*$/,
  /^Rscript\s+[-\w./]+\.R(?:\s+[-\w./:=]+)*$/,
  /^(?:\.\/gradlew|[-\w./]+\/gradlew)\s+(?:-p\s+[-\w./]+\s+)?(?:(?::[-\w]+:)?(?:assembleDebug|assembleRelease|bundleDebug|bundleRelease|compileDebugKotlin|compileReleaseKotlin|testDebugUnitTest|lintDebug|lint|check|build))(?:\s+[-\w./:=]+)*$/,
  /^latexmk\s+(?=[-\w./=\s]*-pdf\b)(?:(?:-cd|-pdf|-interaction=nonstopmode|-halt-on-error|-output-directory=[-\w./]+)\s+)+[-\w./]+\.tex$/,
  /^pdflatex\s+(?:(?:-interaction=nonstopmode|-halt-on-error|-output-directory=[-\w./]+|-jobname\s+[-\w./]+)\s+)*[-\w./]+\.tex$/,
];

const PACKAGE_INSTALL_PATTERNS = [
  /^npm\s+ci$/,
  /^npm\s+install(?:\s+[-@\w./:=]+)*$/,
  /^pnpm\s+install$/,
  /^pnpm\s+add(?:\s+[-@\w./:=]+)+$/,
  /^yarn\s+install$/,
  /^yarn\s+add(?:\s+[-@\w./:=]+)+$/,
  /^python(?:3)?\s+-m\s+pip\s+install\s+-r\s+[-\w./]+$/,
  /^python(?:3)?\s+-m\s+pip\s+install(?:\s+[-@\w./:=]+)+$/,
  /^pip(?:3)?\s+install\s+-r\s+[-\w./]+$/,
  /^pip(?:3)?\s+install(?:\s+[-@\w./:=]+)+$/,
  /^uv\s+(sync|pip\s+install)(?:\s+[-@\w./:=]+)*$/,
  /^conda\s+env\s+(create|update)\s+-f\s+[-\w./]+$/,
  /^conda\s+install(?:\s+[-@\w./:=]+)+$/,
];

const SYSTEM_PACKAGE_INSTALL_PATTERNS = [
  /^(?:sudo\s+)?apt(?:-get)?\s+update$/,
  /^(?:sudo\s+)?apt(?:-get)?\s+install(?:\s+-y)?(?:\s+[-@\w.+:=]+)+$/,
  /^(?:sudo\s+)?(?:dnf|yum)\s+(?:makecache|check-update)(?:\s+[-\w]+)*$/,
  /^(?:sudo\s+)?(?:dnf|yum)\s+install(?:\s+-y)?(?:\s+[-@\w.+:=]+)+$/,
  /^apk\s+add(?:\s+--no-cache)?(?:\s+[-@\w.+:=]+)+$/,
  /^brew\s+install(?:\s+[-@\w.+:=/]+)+$/,
  /^winget\s+install(?:\s+[-@\w.+:=/]+)+$/,
  /^choco\s+install(?:\s+[-@\w.+:=/]+)+$/,
];

const ENV_SETUP_PATTERNS = [
  /^python(?:3)?\s+-m\s+venv\s+\.venv$/,
  /^python(?:3)?\s+-m\s+venv\s+venv$/,
  /^npm\s+init\s+-y$/,
];

const BLOCKED_SHELL_TOKENS = ["&&", "||", ";", "|", ">", "<", "$(", "`"];
const BLOCKED_WRITE_PATTERNS = [
  /(?:^|[\s;&|()])(?:rm|mv|chmod|chown|rmdir|touch|tee)(?=\s|$)/,
  /(?:^|\s)-delete(?=\s|$)/,
  /(?:^|[\s;&|()])git\s+(?:checkout|switch|reset|clean)(?=\s|$)/,
];

const ALWAYS_BLOCKED_PATTERNS = [
  /^npm\s+publish\b/i,
  /^npm\s+token\b/i,
  /^npm\s+(login|adduser)\b/i,
  /^npm\s+config\s+set\s+.*(?:_authToken|token)\b/i,
  /NPM_TOKEN\s*=/i,
  /_authToken\s*=/i,
  /OPENAI_API_KEY\s*=/i,
  /DEEPSEEK_API_KEY\s*=/i,
  /QWEN_API_KEY\s*=/i,
  /VENICE_API_KEY\s*=/i,
  /GRSAI(?:_API_KEY)?\s*=/i,
];

const SENSITIVE_COMMAND_PATTERNS = [
  /(^|[\s./])\.env(\s|$|[./])/i,
  /(^|[\s./])\.npmrc(\s|$|[./])/i,
  /^(env|printenv)(\s|$)/i,
  /(api[_-]?key|auth[_-]?token|npm[_-]?token|_authToken|bearer\s+[A-Za-z0-9._-]+)/i,
];

function normalizePolicy(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function normalizeSandboxMode(value) {
  return normalizePolicy(value, SANDBOX_MODES, "host");
}

export function normalizePackageInstallPolicy(value) {
  return normalizePolicy(value, PACKAGE_INSTALL_POLICIES, "prompt");
}

function isHardBlockedClassification(classification = {}) {
  const reason = String(classification.reason || "");
  return classification.hardBlocked === true || /empty|secret|credential|token|publish/i.test(reason);
}

function matchAny(patterns, command) {
  return patterns.some((pattern) => pattern.test(command));
}

function stripQuotedSegments(command = "") {
  let output = "";
  let quote = "";
  let escaped = false;
  for (const char of String(command || "")) {
    if (quote === "'") {
      if (char === "'") quote = "";
      output += " ";
      continue;
    }
    if (escaped) {
      escaped = false;
      if (!quote) output += " ";
      continue;
    }
    if (char === "\\") {
      escaped = true;
      if (!quote) output += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      output += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      output += " ";
      continue;
    }
    output += char;
  }
  return output;
}

function isSafeRelativeDir(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("~")) return false;
  if (normalized === ".") return true;
  return normalized.split("/").every((part) => part && part !== "." && part !== "..");
}

function isSafeVirtualWorkspaceDir(value) {
  const normalized = String(value || "").trim();
  if (normalized === "/workspace") return true;
  if (!normalized.startsWith("/workspace/")) return false;
  return isSafeRelativeDir(normalized.replace(/^\/workspace\//, ""));
}

function isSafeVirtualWorkspacePath(value) {
  const normalized = String(value || "").trim();
  return normalized.startsWith("/workspace/") && isSafeRelativeDir(normalized.replace(/^\/workspace\//, ""));
}

function isSafeWorkspacePath(value) {
  return isSafeRelativeDir(value) || isSafeVirtualWorkspacePath(value);
}

function isInsideDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativizeWorkspaceAbsolutePaths(command = "", root = "") {
  if (!root) return String(command || "");
  const workspaceRoot = path.resolve(root);
  return String(command || "").replace(/(?<!:)\/[^\s'"|;&<>]+/g, (candidate) => {
    if (candidate.startsWith("//")) return candidate;
    const resolved = path.resolve(candidate);
    if (!isInsideDirectory(workspaceRoot, resolved)) return candidate;
    return path.relative(workspaceRoot, resolved) || ".";
  });
}

export function normalizeCommandForPolicy(command = "", config = {}) {
  return relativizeWorkspaceAbsolutePaths(command, config.commandCwd).trim();
}

function isSafeEnvAssignment(name = "", value = "") {
  if (!SAFE_ENV_ASSIGNMENT_NAMES.has(String(name || ""))) return false;
  if (!value || !SAFE_ENV_VALUE_PATTERN.test(String(value || ""))) return false;
  if (/(?:api[_-]?key|auth[_-]?token|secret|password|_authToken|bearer)/i.test(`${name}=${value}`)) return false;
  return true;
}

function classifySafeEnvExport(normalized = "") {
  const match = normalized.match(/^export\s+([A-Z_][A-Z0-9_]*)=([^\s;&|<>`$]+)$/);
  if (!match) return null;
  const [, name, value] = match;
  if (!isSafeEnvAssignment(name, value)) return null;
  return {
    category: "read-only",
    needsNetwork: false,
    writesWorkspace: false,
    reason: `Safe local toolchain environment assignment: ${name}`,
  };
}

function stripSafeInlineEnvAssignments(command = "") {
  let remaining = String(command || "").trim();
  let stripped = false;
  for (let guard = 0; guard < 8; guard += 1) {
    const match = remaining.match(/^([A-Z_][A-Z0-9_]*)=([^\s;&|<>`$]+)\s+(.+)$/);
    if (!match) break;
    const [, name, value, rest] = match;
    if (!isSafeEnvAssignment(name, value)) break;
    remaining = rest.trim();
    stripped = true;
  }
  return stripped ? remaining : command;
}

function classifySafeEchoRedirect(normalized = "") {
  const match = normalized.match(/^echo\s+(?:"[^"\n]*"|'[^'\n]*'|[-\w.:/]+)\s+>>?\s+([-\w./]+|\/workspace\/[-\w./]+)$/);
  if (!match) return null;
  const target = match[1] || "";
  if (!isSafeWorkspacePath(target)) return null;
  return {
    category: "workspace-write",
    needsNetwork: false,
    writesWorkspace: true,
    virtualWorkspacePath: isSafeVirtualWorkspacePath(target),
    reason: `Command writes a small workspace status log: ${target}`,
  };
}

function extractBoundedCommandSubstitutions(value = "") {
  const text = String(value || "");
  if (!text.includes("$(") || text.length > 16 * 1024 || text.includes("`")) return null;
  const commands = [];
  let template = "";
  let quote = "";
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      template += char;
      if (char === "'") quote = "";
      continue;
    }
    if (escaped) {
      template += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      template += char;
      escaped = true;
      continue;
    }
    if (quote === '"' && char === '"') {
      template += char;
      quote = "";
      continue;
    }
    if (!quote && char === "'") {
      template += char;
      quote = char;
      continue;
    }
    if (!quote && char === '"') {
      template += char;
      quote = '"';
      continue;
    }
    if (char !== "$" || text[index + 1] !== "(") {
      template += char;
      continue;
    }
    if (text[index + 2] === "(" || commands.length >= 4) return null;

    let inner = "";
    let innerQuote = "";
    let innerEscaped = false;
    let closed = false;
    index += 2;
    for (; index < text.length; index += 1) {
      const innerChar = text[index];
      if (innerQuote === "'") {
        inner += innerChar;
        if (innerChar === "'") innerQuote = "";
        continue;
      }
      if (innerEscaped) {
        inner += innerChar;
        innerEscaped = false;
        continue;
      }
      if (innerChar === "\\") {
        inner += innerChar;
        innerEscaped = true;
        continue;
      }
      if (innerQuote === '"') {
        inner += innerChar;
        if (innerChar === '"') innerQuote = "";
        else if (innerChar === "$" && text[index + 1] === "(") return null;
        continue;
      }
      if (innerChar === "'" || innerChar === '"') {
        inner += innerChar;
        innerQuote = innerChar;
        continue;
      }
      if (innerChar === "$" && text[index + 1] === "(") return null;
      if (innerChar === "(" || innerChar === "{") return null;
      if (innerChar === ")") {
        closed = true;
        break;
      }
      inner += innerChar;
    }
    if (!closed || innerQuote || innerEscaped || !inner.trim()) return null;
    commands.push(inner.trim());
    template += `AGINTI_READ_VALUE_${commands.length}`;
  }
  if (!commands.length || quote || escaped || hasActiveShellExpansion(template)) return null;
  return { commands, template };
}

function classifySafeEchoCommandSubstitution(normalized = "") {
  if (!/^echo\s+/.test(String(normalized || ""))) return null;
  const extracted = extractBoundedCommandSubstitutions(normalized);
  if (!extracted) return null;
  const classifications = extracted.commands.map(
    (command) => classifyShellSequence(command) || classifyPipelineSequence(command) || classifySimpleCommand(command)
  );
  const blocked = classifications.find(
    (classification) => classification.category === "blocked" || classification.category === "destructive"
  );
  if (blocked) return blocked;
  if (classifications.some(
    (classification) => classification.category !== "read-only" || classification.writesWorkspace || classification.needsNetwork
  )) {
    return null;
  }
  const templateClassification = classifySimpleCommand(extracted.template);
  if (templateClassification.category !== "read-only" || templateClassification.writesWorkspace) return null;
  return {
    category: "read-only",
    needsNetwork: false,
    writesWorkspace: false,
    gitOnly: false,
    boundedCommandSubstitution: true,
    reason: `Echo uses ${extracted.commands.length} bounded read-only command substitution${extracted.commands.length === 1 ? "" : "s"}.`,
  };
}

function classifyScopedReadOnlyGitProbe(normalized = "") {
  const command = stripBenignRedirections(normalized);
  if (!/^git\s+-C\s+/.test(command) || hasActiveShellExpansion(command)) return null;

  const tokens = tokenizeShellWords(command);
  if (tokens.length < 5 || tokens[0] !== "git" || tokens[1] !== "-C") return null;
  const repository = tokens[2] || "";
  if (
    !repository ||
    repository.startsWith("-") ||
    !/^[A-Za-z0-9_@%+=:,./~+-]+$/.test(repository) ||
    /[*?\[\]{}]/.test(repository)
  ) {
    return null;
  }

  const operation = tokens[3] || "";
  const args = tokens.slice(4);
  const safeStatus = operation === "status" && args.every((arg) =>
    ["--short", "-s", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--branch", "-b"].includes(arg)
  );
  const safeIdentityConfig = operation === "config" && (
    (args.length === 1 && ["user.name", "user.email"].includes(args[0])) ||
    (args.length === 2 && args[0] === "--get" && ["user.name", "user.email"].includes(args[1]))
  );
  const safeRemoteList = operation === "remote" && args.length === 1 && args[0] === "-v";
  if (!safeStatus && !safeIdentityConfig && !safeRemoteList) return null;

  return {
    category: "read-only",
    needsNetwork: false,
    writesWorkspace: false,
    gitOnly: true,
    scopedGitProbe: true,
    reason: `Git ${operation} reads bounded repository metadata through -C.`,
  };
}

function classifyGitCleanDryRun(normalized) {
  const match = normalized.match(/^git\s+clean\b([\s\S]*)$/);
  if (!match) return null;
  const args = match[1] || "";
  if (!/(^|\s)(?:-n\b|--dry-run\b|-[A-Za-z]*n[A-Za-z]*\b)/.test(args)) return null;
  if (/(^|\s)(?:-f\b|--force\b|-[A-Za-z]*f[A-Za-z]*\b)/.test(args)) return null;
  return {
    category: "read-only",
    needsNetwork: false,
    writesWorkspace: false,
    reason: "Git clean dry-run is read-only inspection evidence.",
  };
}

function classifyGitClone(normalized) {
  const match = normalized.match(
    /^git\s+clone(?:\s+--depth\s+\d+)?(?:\s+--branch\s+[-\w./]+)?\s+(https:\/\/\S+)(?:\s+([-\w./]+))?$/
  );
  if (!match) return null;

  const target = match[2] || "";
  if (target && !isSafeRelativeDir(target) && !isSafeVirtualWorkspaceDir(target)) {
    return {
      category: "blocked",
      reason: `git clone target must be a safe workspace-relative directory: ${target}`,
    };
  }

  return {
    category: "git-remote",
    needsNetwork: true,
    writesWorkspace: true,
    virtualWorkspacePath: Boolean(target && isSafeVirtualWorkspaceDir(target)),
    reason: "Git clone writes into the workspace and requires network access.",
  };
}

function classifyGitWorkflow(normalized) {
  // Git arguments accepted here are executed through a shell. Keep expansion
  // syntax out of this narrow allowlist while preserving literal commit/tag
  // text protected by single quotes.
  if (hasActiveShellExpansion(normalized)) return null;
  if (!matchAny(GIT_WORKFLOW_PATTERNS, normalized)) return null;
  const remote = /^git\s+(fetch|pull|push)\b/.test(normalized);
  const writesWorkspace = !/^git\s+fetch\b/.test(normalized);
  return {
    category: remote ? "git-remote" : "git-workflow",
    needsNetwork: remote,
    writesWorkspace,
    gitOnly: true,
    reason:
      remote
        ? "Git remote workflow command. Agent should inspect status/diff first and stop on divergence or conflicts."
        : "Local git workflow command. Agent should inspect status/diff first and stop on conflicts or unrelated dirty work.",
  };
}

function classifyCondaRun(normalized) {
  const tokens = String(normalized || "").match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  if (tokens[0] !== "conda" || tokens[1] !== "run") return null;
  let index = 2;
  while (index < tokens.length) {
    const token = String(tokens[index] || "");
    if (["-n", "--name", "-p", "--prefix"].includes(token)) {
      if (!tokens[index + 1] || !/^[-\w./]+$/.test(String(tokens[index + 1]))) return null;
      index += 2;
      continue;
    }
    if (["--no-capture-output", "--live-stream"].includes(token)) {
      index += 1;
      continue;
    }
    break;
  }
  const inner = tokens.slice(index).join(" ").trim();
  if (!inner) return null;
  const innerClassification = classifyPipelineSequence(inner) || classifySimpleCommand(inner);
  return {
    ...innerClassification,
    reason: `Conda run delegates to a ${innerClassification.category} command: ${inner}`,
  };
}

function classifySimpleCommand(normalized) {
  const benignRedirectCommand = stripBenignRedirections(normalized);
  if (ALWAYS_BLOCKED_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { category: "blocked", reason: "Command is blocked because it may expose secrets or publish packages." };
  }
  if (SENSITIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { category: "blocked", reason: "Command is blocked because it references secrets or credential files." };
  }
  const gitCleanDryRun = classifyGitCleanDryRun(normalized);
  if (gitCleanDryRun) return gitCleanDryRun;
  const scopedReadOnlyGitProbe = classifyScopedReadOnlyGitProbe(normalized);
  if (scopedReadOnlyGitProbe) return scopedReadOnlyGitProbe;
  const gitWorkflowClassification = classifyGitWorkflow(normalized);
  if (gitWorkflowClassification) return gitWorkflowClassification;
  const condaRunClassification = classifyCondaRun(normalized);
  if (condaRunClassification) return condaRunClassification;
  if (matchAny(UNSAFE_GIT_PATTERNS, normalized)) {
    const unquoted = stripQuotedSegments(normalized);
    return {
      category: "destructive",
      needsApproval: true,
      writesWorkspace: true,
      gitOnly:
        /^git\s+/.test(normalized) &&
        !/[;&|<>()]/.test(unquoted) &&
        !hasActiveShellExpansion(normalized),
      reason:
        "Git merge/rebase/reset/checkout/switch/clean, and non-ff-only pulls, can rewrite or conflict with local work. Inspect status/diff first and ask the user when the repository is divergent or conflicted.",
    };
  }

  if (matchAny(SAFE_WORKSPACE_WRITE_PATTERNS, normalized)) {
    const target = normalized.replace(/^mkdir\s+-p\s+/, "");
    const virtualWorkspacePath = isSafeVirtualWorkspaceDir(target);
    if (!isSafeRelativeDir(target) && !virtualWorkspacePath) {
      return { category: "blocked", reason: `mkdir target must be a safe workspace-relative directory: ${target}` };
    }
    return { category: "workspace-write", needsNetwork: false, writesWorkspace: true, virtualWorkspacePath };
  }
  if (matchAny(PERMISSION_CHANGE_PATTERNS, normalized)) {
    const target = normalized.split(/\s+/).at(-1) || "";
    const virtualWorkspacePath = isSafeVirtualWorkspacePath(target);
    if (!isSafeWorkspacePath(target)) {
      return { category: "blocked", reason: `chmod target must be a safe workspace-relative path: ${target}` };
    }
    return {
      category: "permission-change",
      needsNetwork: false,
      writesWorkspace: true,
      virtualWorkspacePath,
      reason: `Command changes workspace file mode: ${normalized}`,
    };
  }
  const gitCloneClassification = classifyGitClone(normalized);
  if (gitCloneClassification) return gitCloneClassification;
  const envExportClassification = classifySafeEnvExport(normalized);
  if (envExportClassification) return envExportClassification;
  const echoRedirectClassification = classifySafeEchoRedirect(normalized);
  if (echoRedirectClassification) return echoRedirectClassification;
  const echoCommandSubstitutionClassification = classifySafeEchoCommandSubstitution(normalized);
  if (echoCommandSubstitutionClassification) return echoCommandSubstitutionClassification;

  if (isUnboundedRecursiveGrep(normalized)) {
    return {
      category: "unbounded-discovery",
      needsNetwork: false,
      writesWorkspace: false,
      reason:
        "Recursive grep is blocked as unbounded discovery. Use a bounded workspace search tool or targeted `rg` with an explicit path, globs, and result limit.",
    };
  }

  const commandForPatternMatching = stripSafeInlineEnvAssignments(benignRedirectCommand);
  if (hasActiveShellCommandSubstitution(commandForPatternMatching)) {
    return {
      category: "general-shell",
      needsNetwork: true,
      writesWorkspace: true,
      reason: `Command uses active shell expansion outside the bounded command policy: ${normalized}`,
    };
  }
  const validationTokens = tokenizeShellWords(commandForPatternMatching);
  const delegatedValidationPlan = delegatedValidationPlanClassification(validationTokens);
  if (delegatedValidationPlan) return delegatedValidationPlan;
  const unquoted = stripQuotedSegments(commandForPatternMatching);
  const lowered = unquoted.toLowerCase();
  if (BLOCKED_WRITE_PATTERNS.some((pattern) => pattern.test(lowered))) {
    return {
      category: "destructive",
      needsNetwork: false,
      writesWorkspace: true,
      reason: `Command contains a write-capable or destructive token: ${normalized}`,
    };
  }
  if (BLOCKED_SHELL_TOKENS.some((part) => unquoted.includes(part))) {
    return {
      category: "general-shell",
      needsNetwork: true,
      writesWorkspace: true,
      reason: `Command uses general shell syntax: ${normalized}`,
    };
  }

  if (
    matchAny(READ_ONLY_PATTERNS, commandForPatternMatching) ||
    isReadOnlyPrintfCommand(commandForPatternMatching) ||
    isReadOnlyTrDeleteFilter(commandForPatternMatching) ||
    isReadOnlySha256Command(commandForPatternMatching) ||
    isReadOnlyFindCommand(normalized) ||
    (!hasActiveShellExpansion(benignRedirectCommand) && isReadOnlyShellCondition(benignRedirectCommand))
  ) {
    return {
      category: "read-only",
      needsNetwork: false,
      writesWorkspace: false,
      gitOnly: /^git\s+/.test(commandForPatternMatching),
    };
  }
  const packageScript = packageManagerScriptName(validationTokens);
  if (invokesPackageManagerScript(validationTokens) && packageScriptHasUnsafeLifecycle(packageScript)) {
    return {
      category: "blocked",
      needsNetwork: true,
      writesWorkspace: true,
      reason:
        `Package script ${packageScript} has an external, credential, or environment lifecycle name and cannot be treated as bounded validation.`,
    };
  }
  const structuredValidation = structuredValidationCommand(commandForPatternMatching);
  if (structuredValidation || matchAny(TEST_PATTERNS, commandForPatternMatching)) {
    const mayMutateProject =
      structuredValidation?.mayMutateProject ??
      validationCommandMayMutateProject(commandForPatternMatching);
    return {
      category: "test",
      needsNetwork: false,
      writesWorkspace: mayMutateProject,
      mayMutateProject,
      virtualWorkspacePath: validationExecutablePathMetadata(validationTokens[0])
        .virtualWorkspacePath,
      substantiveTest:
        !testInvocationIsInformational(validationTokens) &&
        (structuredValidation?.substantiveTest ??
          matchAny(SUBSTANTIVE_TEST_PATTERNS, commandForPatternMatching)),
    };
  }
  if (matchAny(TOOLCHAIN_PATTERNS, commandForPatternMatching)) {
    return { category: "toolchain", needsNetwork: false, writesWorkspace: true };
  }
  if (matchAny(NETWORK_FETCH_PATTERNS, commandForPatternMatching)) {
    const writesWorkspace = networkFetchWritesWorkspace(commandForPatternMatching);
    return {
      category: "network-fetch",
      needsNetwork: true,
      writesWorkspace,
      mayMutateProject: writesWorkspace,
    };
  }
  if (matchAny(SYSTEM_PACKAGE_INSTALL_PATTERNS, commandForPatternMatching)) {
    return { category: "system-package-install", needsNetwork: true, writesWorkspace: false, requiresDockerRoot: true };
  }
  if (matchAny(PACKAGE_INSTALL_PATTERNS, commandForPatternMatching)) {
    return { category: "package-install", needsNetwork: true, writesWorkspace: true };
  }
  if (matchAny(ENV_SETUP_PATTERNS, commandForPatternMatching)) {
    return { category: "env-setup", needsNetwork: false, writesWorkspace: true };
  }

  return {
    category: "general-shell",
    needsNetwork: false,
    // Anything outside the bounded read-only allowlist may mutate project
    // state. Treating an unknown shell command as read-only lets callers
    // bypass revision, test, and artifact guards through tools such as
    // interpreters or in-place editors.
    writesWorkspace: true,
    reason: `Command is outside the narrow allowlist and requires a trusted shell policy: ${normalized}`,
  };
}

function splitTopLevelShellSequence(command = "") {
  const parts = [];
  const separators = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let hadSeparator = false;
  const text = String(command || "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      current += char;
      if (char === "'") quote = "";
      continue;
    }
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote === '"') {
      current += char;
      if (char === '"') quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    const newlineSeparator = char === "\n" || char === "\r";
    if (char === "&" && text[index + 1] === "&" && /^\s*cd\s+/i.test(current)) {
      current += "&&";
      index += 1;
      continue;
    }
    if (newlineSeparator || char === ";" || (char === "&" && text[index + 1] === "&") || (char === "|" && text[index + 1] === "|")) {
      const part = current.trim();
      if (!part) {
        if (newlineSeparator) {
          if (char === "\r" && text[index + 1] === "\n") index += 1;
          continue;
        }
        return null;
      }
      parts.push(part);
      separators.push(
        newlineSeparator ? "newline" : char === ";" ? ";" : char === "&" ? "&&" : "||"
      );
      current = "";
      hadSeparator = true;
      if (char === "&" || char === "|" || (char === "\r" && text[index + 1] === "\n")) index += 1;
      continue;
    }
    current += char;
  }
  const finalPart = current.trim();
  if (finalPart) parts.push(finalPart);
  if (!hadSeparator || parts.length < 2) return null;
  return { parts, separators };
}

function classifyShellSequence(normalized) {
  const sequence = splitTopLevelShellSequence(normalized);
  if (!sequence) return null;
  const { parts, separators } = sequence;
  const classifications = parts.map((part) => classifyCdCommand(part) || classifyPipelineSequence(part) || classifySimpleCommand(part));
  const blocked = classifications.find((classification) => classification.category === "blocked" || classification.category === "destructive");
  if (blocked) return { ...blocked, gitOnly: false };
  const broad = classifications.find((classification) => classification.category === "general-shell");
  if (broad) {
    return {
      ...broad,
      reason: `Command sequence includes a broad shell segment and requires trusted shell policy: ${normalized}`,
    };
  }
  const categories = new Set(classifications.map((classification) => classification.category));
  const aggregate = {
    needsNetwork: classifications.some((classification) => classification.needsNetwork),
    writesWorkspace: classifications.some((classification) => classification.writesWorkspace),
    requiresDockerRoot: classifications.some((classification) => classification.requiresDockerRoot),
    virtualWorkspacePath: classifications.some((classification) => classification.virtualWorkspacePath),
    gitOnly: classifications.every((classification) => classification.gitOnly === true),
    mayMutateProject: classifications.some((classification) => classification.mayMutateProject === true),
    substantiveTest:
      separators.every((separator) => separator === "&&") &&
      classifications.some((classification) => classification.substantiveTest === true),
    reason: `Command sequence uses shell separators with individually classified safe segments: ${normalized}`,
  };
  if (categories.has("system-package-install")) return { category: "system-package-install", ...aggregate };
  if (categories.has("package-install")) return { category: "package-install", ...aggregate };
  if (categories.has("env-setup")) return { category: "env-setup", ...aggregate };
  if (categories.has("permission-change")) return { category: "permission-change", ...aggregate };
  if (categories.has("git-remote")) return { category: "git-remote", ...aggregate };
  if (categories.has("network-fetch")) return { category: "network-fetch", ...aggregate };
  if (categories.has("toolchain")) return { category: "toolchain", ...aggregate };
  if (categories.has("workspace-write")) return { category: "workspace-write", ...aggregate };
  if (categories.has("test")) return { category: "test", ...aggregate };
  if (categories.has("git-workflow")) return { category: "git-workflow", ...aggregate };
  return {
    category: "read-only",
    ...aggregate,
  };
}

const READ_ONLY_FOR_LOOP_MAX_ITEMS = 64;
const READ_ONLY_FOR_LOOP_MAX_COMMANDS = 16;
const READ_ONLY_FOR_LOOP_LITERAL_PATTERN = /^[A-Za-z0-9_@%+=:,./~+ -]+$/;

function shellIdentifierPattern(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function broadForLoopClassification(normalized, reason) {
  return {
    category: "general-shell",
    needsNetwork: false,
    writesWorkspace: true,
    reason: `Shell for-loop is outside the bounded read-only form (${reason}): ${normalized}`,
  };
}

function findUnquotedShellWord(value = "", expectedWord = "", startIndex = 0) {
  const text = String(value || "");
  const word = String(expectedWord || "");
  let quote = "";
  let escaped = false;

  for (let index = 0; index <= text.length - word.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = "";
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (index < Math.max(0, startIndex) || text.slice(index, index + word.length) !== word) continue;
    const before = index > 0 ? text[index - 1] : "";
    const after = text[index + word.length] || "";
    if ((!before || !/[A-Za-z0-9_]/.test(before)) && (!after || !/[A-Za-z0-9_]/.test(after))) {
      return index;
    }
  }
  return -1;
}

function trimShellListBoundary(value = "") {
  return String(value || "")
    .replace(/^[\s;]+/, "")
    .replace(/[\s;]+$/, "")
    .trim();
}

function classifyReadOnlyCommandList(value = "") {
  const text = trimShellListBoundary(value);
  if (!text) {
    return {
      category: "read-only",
      needsNetwork: false,
      writesWorkspace: false,
      emptyCommandList: true,
    };
  }
  const sequence = splitTopLevelShellSequence(text);
  if (sequence && sequence.parts.length > READ_ONLY_FOR_LOOP_MAX_COMMANDS) {
    return broadForLoopClassification(text, "the command list is too large");
  }
  return classifyShellSequence(text) || classifyPipelineSequence(text) || classifySimpleCommand(text);
}

function isReadOnlyShellCondition(value = "") {
  const tokens = tokenizeShellWords(trimShellListBoundary(value));
  let option = "";
  let candidate = "";
  if (tokens.length === 4 && tokens[0] === "[" && tokens[3] === "]") {
    [, option, candidate] = tokens;
  } else if (tokens.length === 3 && tokens[0] === "test") {
    [, option, candidate] = tokens;
  } else {
    return false;
  }
  return /^-[efdx]$/.test(option) &&
    !candidate.startsWith("-") &&
    READ_ONLY_FOR_LOOP_LITERAL_PATTERN.test(candidate);
}

function classifyReadOnlyLoopBody(bodySource = "") {
  const text = String(bodySource || "").trim();
  const controlWords = ["if", "then", "else", "elif", "fi", "for", "do", "done", "while", "until", "case", "esac"];
  const presentControls = controlWords.filter((word) => findUnquotedShellWord(text, word) >= 0);
  if (!presentControls.length) return classifyReadOnlyCommandList(text);

  if (presentControls.some((word) => !["if", "then", "else", "fi"].includes(word))) {
    return broadForLoopClassification(text, "the body contains nested or unsupported control flow");
  }

  const ifIndex = findUnquotedShellWord(text, "if");
  const thenIndex = findUnquotedShellWord(text, "then", ifIndex + 2);
  const elseIndex = findUnquotedShellWord(text, "else", thenIndex + 4);
  const fiIndex = findUnquotedShellWord(text, "fi", elseIndex + 4);
  if (ifIndex < 0 || thenIndex < 0 || elseIndex < 0 || fiIndex < 0 ||
      findUnquotedShellWord(text, "if", ifIndex + 2) >= 0 ||
      findUnquotedShellWord(text, "then", thenIndex + 4) >= 0 ||
      findUnquotedShellWord(text, "else", elseIndex + 4) >= 0 ||
      findUnquotedShellWord(text, "fi", fiIndex + 2) >= 0) {
    return broadForLoopClassification(text, "the conditional is not a single bounded if/else block");
  }

  const prefix = trimShellListBoundary(text.slice(0, ifIndex));
  const condition = trimShellListBoundary(text.slice(ifIndex + 2, thenIndex));
  const thenBranch = trimShellListBoundary(text.slice(thenIndex + 4, elseIndex));
  const elseBranch = trimShellListBoundary(text.slice(elseIndex + 4, fiIndex));
  const suffix = trimShellListBoundary(text.slice(fiIndex + 2));
  if (!isReadOnlyShellCondition(condition) || !thenBranch || !elseBranch) {
    return broadForLoopClassification(text, "the conditional test or branch is not bounded read-only syntax");
  }

  const classifications = [prefix, thenBranch, elseBranch, suffix]
    .filter(Boolean)
    .map((part) => classifyReadOnlyCommandList(part));
  const blocked = classifications.find(
    (classification) => classification.category === "blocked" || classification.category === "destructive"
  );
  if (blocked) return { ...blocked, gitOnly: false };
  if (classifications.some(
    (classification) => classification.category !== "read-only" || classification.writesWorkspace
  )) {
    return broadForLoopClassification(text, "a conditional branch is not read-only");
  }
  return {
    category: "read-only",
    needsNetwork: false,
    writesWorkspace: false,
    boundedConditional: true,
  };
}

function loopBodyHasOnlyBoundedReadOnlyExpansions(bodySource = "") {
  const text = String(bodySource || "").trim();
  if (!hasActiveShellExpansion(text)) return true;
  const sequence = parseTopLevelShellSequence(text);
  if (
    !sequence.commands.length ||
    sequence.openQuote ||
    sequence.trailingEscape ||
    sequence.trailingSeparator
  ) {
    return false;
  }
  return sequence.commands.every((command) => {
    if (!hasActiveShellExpansion(command)) return true;
    const classification = classifySafeEchoCommandSubstitution(command);
    return classification?.category === "read-only" &&
      classification.writesWorkspace === false &&
      classification.needsNetwork === false;
  });
}

function isBoundedReadOnlyScalarCommand(command = "") {
  const normalized = stripBenignRedirections(command);
  if (!normalized || hasActiveShellExpansion(normalized)) return false;
  const pipeline = splitTopLevelPipeline(normalized);
  if (pipeline) {
    if (pipeline.length > 4) return false;
    const classifications = pipeline.map((part) => classifySimpleCommand(part));
    if (classifications.some(
      (classification) => classification.category !== "read-only" || classification.writesWorkspace
    )) {
      return false;
    }
    const producers = [...pipeline];
    if (isReadOnlyTrDeleteFilter(producers.at(-1))) producers.pop();
    const finalProducer = stripBenignRedirections(producers.at(-1) || "");
    const finalTokens = tokenizeShellWords(finalProducer);
    return finalTokens[0] === "wc" &&
      finalTokens.length === 2 &&
      ["-l", "--lines"].includes(finalTokens[1]);
  }
  const tokens = tokenizeShellWords(normalized);
  if (!tokens.length) return false;
  if (["grep", "rg"].includes(tokens[0])) {
    return tokens.slice(1).some((token) =>
      token === "--count" || /^-[A-Za-z]*c[A-Za-z]*$/.test(token)
    );
  }
  return tokens[0] === "wc" && tokens.slice(1).includes("-l");
}

function parseReadOnlyLoopBodySequence(value = "") {
  const text = String(value || "");
  const commands = [];
  const separators = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let substitutionDepth = 0;

  const push = (separator) => {
    const command = current.trim();
    if (!command) return false;
    commands.push(command);
    separators.push(separator);
    current = "";
    return true;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      current += char;
      if (char === "'") quote = "";
      continue;
    }
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? "" : '"';
      current += char;
      continue;
    }
    if (!quote && char === "'") {
      quote = "'";
      current += char;
      continue;
    }
    if (char === "$" && text[index + 1] === "(") {
      substitutionDepth += 1;
      current += "$(";
      index += 1;
      continue;
    }
    if (!quote && char === ")" && substitutionDepth > 0) {
      substitutionDepth -= 1;
      current += char;
      continue;
    }
    if (!quote && substitutionDepth === 0) {
      const pair = text.slice(index, index + 2);
      if (pair === "&&" || pair === "||") {
        if (!push(pair)) return null;
        index += 1;
        continue;
      }
      if (char === ";" || char === "\n") {
        if (current.trim() && !push(char === "\n" ? "newline" : char)) return null;
        continue;
      }
    }
    current += char;
  }
  if (quote || escaped || substitutionDepth !== 0) return null;
  if (current.trim()) commands.push(current.trim());
  if (!commands.length || separators.length >= commands.length) return null;
  return { commands, separators };
}

function commandHasUnbalancedSubstitution(value = "") {
  const text = String(value || "");
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "$" && text[index + 1] === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (text[index] === ")" && depth > 0) depth -= 1;
  }
  return depth !== 0;
}

function sanitizeReadOnlyLoopAssignments(bodySource = "") {
  const text = String(bodySource || "").trim();
  const standardSequence = parseTopLevelShellSequence(text);
  const standardIsUsable =
    standardSequence.commands.length > 0 &&
    !standardSequence.openQuote &&
    !standardSequence.trailingEscape &&
    !standardSequence.trailingSeparator &&
    !standardSequence.commands.some(commandHasUnbalancedSubstitution);
  const sequence = standardIsUsable
    ? standardSequence
    : parseReadOnlyLoopBodySequence(text);
  if (!sequence) return null;

  const assigned = new Map();
  const commands = [];
  for (const sourceCommand of sequence.commands) {
    let command = sourceCommand;
    for (const [name, state] of assigned.entries()) {
      const escapedName = shellIdentifierPattern(name);
      const reference = new RegExp(`\\$(?:\\{${escapedName}\\}|${escapedName}(?![A-Za-z0-9_]))`, "g");
      if (!reference.test(command)) continue;
      if (!/^(?:echo|printf)\s+/.test(command)) return null;
      command = command.replace(reference, `AGINTI_READ_VALUE_${name}`);
      state.used = true;
    }

    const assignment = command.match(/^([A-Za-z_][A-Za-z0-9_]*)=(\$\([\s\S]+\))$/);
    if (!assignment) {
      commands.push(command);
      continue;
    }
    const [, name, expression] = assignment;
    if (assigned.has(name) || assigned.size >= 4) return null;
    const extracted = extractBoundedCommandSubstitutions(`echo ${expression}`);
    if (
      !extracted ||
      extracted.commands.length !== 1 ||
      extracted.template !== "echo AGINTI_READ_VALUE_1"
    ) {
      return null;
    }
    const inner = extracted.commands[0];
    const classification = classifyShellSequence(inner) ||
      classifyPipelineSequence(inner) ||
      classifySimpleCommand(inner);
    if (
      classification.category !== "read-only" ||
      classification.writesWorkspace ||
      classification.needsNetwork ||
      !isBoundedReadOnlyScalarCommand(inner)
    ) {
      return null;
    }
    assigned.set(name, { used: false });
    commands.push("true");
  }
  if ([...assigned.values()].some((state) => !state.used)) return null;

  let sanitized = commands[0];
  for (let index = 1; index < commands.length; index += 1) {
    const separator = sequence.separators[index - 1] === "newline"
      ? "\n"
      : sequence.separators[index - 1] || ";";
    sanitized += separator === "\n"
      ? `\n${commands[index]}`
      : ` ${separator} ${commands[index]}`;
  }
  return sanitized;
}

const READ_ONLY_LITERAL_ASSIGNMENT_MAX = 8;

function boundedLiteralAssignment(command = "") {
  const source = String(command || "").trim();
  if (!source || hasActiveShellExpansion(source)) return null;
  const tokens = tokenizeShellWords(source);
  if (tokens.length !== 1) return null;
  const match = tokens[0].match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]+)$/);
  if (!match) return null;
  const [, name, value] = match;
  if (
    value.startsWith("-") ||
    !READ_ONLY_FOR_LOOP_LITERAL_PATTERN.test(value) ||
    /[\r\n]/.test(value)
  ) {
    return null;
  }
  return { name, value };
}

function replaceBoundedLiteralReferences(source = "", name = "", value = "") {
  const text = String(source || "");
  let result = "";
  let quote = "";
  let escaped = false;
  let replacements = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      result += char;
      if (char === "'") quote = "";
      continue;
    }
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      result += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? "" : '"';
      result += char;
      continue;
    }
    if (!quote && char === "'") {
      quote = "'";
      result += char;
      continue;
    }
    if (char !== "$") {
      result += char;
      continue;
    }
    const braced = text.startsWith(`\${${name}}`, index);
    const bare = text.startsWith(`$${name}`, index) &&
      !/[A-Za-z0-9_]/.test(text[index + name.length + 1] || "");
    if (!braced && !bare) {
      result += char;
      continue;
    }
    result += quote === '"' || !/\s/.test(value) ? value : `'${value}'`;
    replacements += 1;
    index += braced ? name.length + 2 : name.length;
  }
  return { text: result, replacements };
}

function joinParsedShellSequence(commands = [], separators = []) {
  let result = commands[0] || "";
  for (let index = 1; index < commands.length; index += 1) {
    const separator = separators[index - 1] === "newline"
      ? "\n"
      : separators[index - 1] || ";";
    result += separator === "\n"
      ? `\n${commands[index]}`
      : ` ${separator} ${commands[index]}`;
  }
  return result;
}

function sanitizeReadOnlyCompoundLiteralAssignments({
  prefixSource = "",
  loopSource = "",
  suffixSource = "",
  loopVariable = "",
} = {}) {
  const parsed = parseTopLevelShellSequence(prefixSource);
  if (
    !parsed.commands.length ||
    parsed.openQuote ||
    parsed.trailingEscape ||
    parsed.trailingSeparator
  ) {
    return null;
  }

  const assignments = new Map();
  const commands = [];
  for (const sourceCommand of parsed.commands) {
    const assignment = boundedLiteralAssignment(sourceCommand);
    if (assignment) {
      if (
        assignments.has(assignment.name) ||
        assignment.name === loopVariable ||
        assignments.size >= READ_ONLY_LITERAL_ASSIGNMENT_MAX
      ) {
        return null;
      }
      assignments.set(assignment.name, { value: assignment.value, used: false });
      commands.push("true");
      continue;
    }
    let command = sourceCommand;
    for (const [name, state] of assignments.entries()) {
      const replaced = replaceBoundedLiteralReferences(command, name, state.value);
      command = replaced.text;
      state.used ||= replaced.replacements > 0;
    }
    commands.push(command);
  }
  if (!assignments.size) {
    return { prefixSource, loopSource, suffixSource };
  }

  let sanitizedLoop = loopSource;
  let sanitizedSuffix = suffixSource;
  for (const [name, state] of assignments.entries()) {
    const loopReplacement = replaceBoundedLiteralReferences(sanitizedLoop, name, state.value);
    sanitizedLoop = loopReplacement.text;
    const suffixReplacement = replaceBoundedLiteralReferences(sanitizedSuffix, name, state.value);
    sanitizedSuffix = suffixReplacement.text;
    state.used ||= loopReplacement.replacements > 0 || suffixReplacement.replacements > 0;
  }
  if ([...assignments.values()].some((state) => !state.used)) return null;
  return {
    prefixSource: joinParsedShellSequence(commands, parsed.separators),
    loopSource: sanitizedLoop,
    suffixSource: sanitizedSuffix,
  };
}

function classifyReadOnlyForLoop(normalized) {
  const text = String(normalized || "").trim();
  if (!/^for\s+/.test(text)) return null;
  if (text.length > 64 * 1024) {
    return broadForLoopClassification(text, "command is too large");
  }

  const match = text.match(
    /^for[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in[ \t]+([\s\S]*?)(?:;|\n)[ \t]*do\s+([\s\S]*?)(?:;|\n)[ \t]*done[ \t]*$/
  );
  if (!match) return broadForLoopClassification(text, "unsupported loop syntax");

  const [, variableName, itemSource, bodySource] = match;
  if (hasActiveShellExpansion(itemSource) || hasActiveShellCommandSubstitution(itemSource)) {
    return broadForLoopClassification(text, "the item list is dynamic");
  }
  // A model commonly formats a finite literal list with shell line
  // continuations. Removing only the exact backslash-newline token preserves
  // the same static list without admitting arbitrary escapes or expansion.
  const normalizedItemSource = itemSource.replace(/\\\r?\n/g, " ");
  const items = tokenizeShellWords(normalizedItemSource);
  if (!items.length || items.length > READ_ONLY_FOR_LOOP_MAX_ITEMS) {
    return broadForLoopClassification(text, "the item list is empty or unbounded");
  }
  if (items.some((item) => item.startsWith("-") || !READ_ONLY_FOR_LOOP_LITERAL_PATTERN.test(item))) {
    return broadForLoopClassification(
      text,
      "items must be finite literal words or paths without option prefixes or globs"
    );
  }

  const escapedVariable = shellIdentifierPattern(variableName);
  const variableReference = new RegExp(
    `\\$(?:\\{${escapedVariable}\\}|${escapedVariable}(?![A-Za-z0-9_]))`,
    "g"
  );
  const referenceCount = [...bodySource.matchAll(variableReference)].length;
  if (!referenceCount) {
    return broadForLoopClassification(text, "the body does not consume the loop item");
  }

  for (const item of items) {
    const expandedBody = bodySource.replace(variableReference, item);
    const sanitizedBody = sanitizeReadOnlyLoopAssignments(expandedBody);
    if (!sanitizedBody || !loopBodyHasOnlyBoundedReadOnlyExpansions(sanitizedBody)) {
      return broadForLoopClassification(text, "the body contains expansion beyond the loop variable");
    }
    const classification = classifyReadOnlyLoopBody(sanitizedBody);
    if (classification.category === "blocked" || classification.category === "destructive") {
      return { ...classification, gitOnly: false };
    }
    if (classification.category !== "read-only" || classification.writesWorkspace) {
      return broadForLoopClassification(text, `body is ${classification.category}`);
    }
  }

  return {
    category: "read-only",
    needsNetwork: false,
    writesWorkspace: false,
    gitOnly: false,
    boundedForLoop: true,
    reason: `Finite read-only shell loop over ${items.length} literal item${items.length === 1 ? "" : "s"}.`,
  };
}

function classifyReadOnlyCompoundSequence(normalized) {
  const text = String(normalized || "").trim();
  if (!text) return null;

  let forIndex = findUnquotedShellWord(text, "for");
  const startsAtCommandBoundary = (index) => {
    let boundary = index - 1;
    while (boundary >= 0 && /[ \t]/.test(text[boundary])) boundary -= 1;
    return boundary >= 0 && /[;\n\r]/.test(text[boundary]);
  };
  while (forIndex > 0 && !startsAtCommandBoundary(forIndex)) {
    forIndex = findUnquotedShellWord(text, "for", forIndex + 3);
  }
  if (forIndex < 0) return null;

  let prefixSource = trimShellListBoundary(text.slice(0, forIndex));
  const doneIndex = findUnquotedShellWord(text, "done", forIndex + 3);
  if (doneIndex < 0) return null;
  let loopSource = text.slice(forIndex, doneIndex + 4).trim();
  let suffixSource = trimShellListBoundary(text.slice(doneIndex + 4));
  if (!prefixSource && !suffixSource) return null;

  const loopVariable = loopSource.match(/^for[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in\b/)?.[1] || "";
  if (prefixSource) {
    const sanitized = sanitizeReadOnlyCompoundLiteralAssignments({
      prefixSource,
      loopSource,
      suffixSource,
      loopVariable,
    });
    if (!sanitized) {
      return broadForLoopClassification(text, "the prelude contains an unsafe or unused shell assignment");
    }
    ({ prefixSource, loopSource, suffixSource } = sanitized);
  }

  for (const [label, source] of [["prelude", prefixSource], ["suffix", suffixSource]]) {
    if (!source) continue;
    const classification = classifyReadOnlyCommandList(source);
    if (classification.category === "blocked" || classification.category === "destructive") {
      return { ...classification, gitOnly: false };
    }
    if (classification.category !== "read-only" || classification.writesWorkspace) {
      return broadForLoopClassification(text, `the command ${label} is not read-only`);
    }
  }
  const loopClassification = classifyReadOnlyForLoop(loopSource);
  if (!loopClassification) return null;
  if (loopClassification.category !== "read-only" || loopClassification.writesWorkspace) {
    return loopClassification;
  }
  return {
    category: "read-only",
    needsNetwork: false,
    writesWorkspace: false,
    gitOnly: false,
    boundedForLoop: true,
    boundedCompoundSequence: true,
    reason: "A bounded read-only shell loop has only finite read-only command context.",
  };
}

function splitTopLevelPipeline(command = "") {
  const parts = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let hadPipe = false;
  const text = String(command || "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      current += char;
      if (char === "'") quote = "";
      continue;
    }
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote === '"') {
      current += char;
      if (char === '"') quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === "|" && text[index + 1] !== "|") {
      const part = current.trim();
      if (!part) return null;
      parts.push(part);
      current = "";
      hadPipe = true;
      continue;
    }
    current += char;
  }
  const finalPart = current.trim();
  if (finalPart) parts.push(finalPart);
  if (!hadPipe || parts.length < 2) return null;
  return parts;
}

function classifyPipelineSequence(normalized) {
  const parts = splitTopLevelPipeline(normalized);
  if (!parts) return null;
  const classifications = parts.map((part) => classifyCdCommand(part) || classifySimpleCommand(part));
  const blocked = classifications.find((classification) => classification.category === "blocked" || classification.category === "destructive");
  if (blocked) return blocked;
  if (classifications.every((classification) => classification.category === "read-only")) {
    return {
      category: "read-only",
      needsNetwork: false,
      writesWorkspace: false,
      reason: `Read-only shell pipeline: ${normalized}`,
    };
  }
  const benignPipelineCategories = new Set(["read-only", "network-fetch", "test"]);
  if (
    classifications.every((classification) => benignPipelineCategories.has(classification.category) && !classification.writesWorkspace)
  ) {
    return {
      category: classifications.some((classification) => classification.category === "network-fetch") ? "network-fetch" : "read-only",
      needsNetwork: classifications.some((classification) => classification.needsNetwork),
      writesWorkspace: false,
      reason: `Benign read/network shell pipeline: ${normalized}`,
    };
  }
  return {
    category: "general-shell",
    needsNetwork: classifications.some((classification) => classification.needsNetwork),
    writesWorkspace: classifications.some((classification) => classification.writesWorkspace),
    reason: `Shell pipeline includes a broad segment and requires trusted shell policy: ${normalized}`,
  };
}

function classifyCdCommand(normalized) {
  const match = normalized.match(/^cd\s+([-\w./]+)(?:\s+(?:2>&1|1>&2|2>\/dev\/null|1>\/dev\/null|>\/dev\/null))?\s+&&\s+(.+)$/);
  if (!match) return null;
  const [, dir, inner] = match;
  const virtualWorkspacePath = isSafeVirtualWorkspaceDir(dir);
  if (!isSafeRelativeDir(dir) && !virtualWorkspacePath) {
    return { category: "blocked", reason: `cd target must be a safe workspace-relative directory: ${dir}` };
  }
  const innerClassification = classifyReadOnlyCompoundSequence(inner.trim()) ||
    classifyReadOnlyForLoop(inner.trim()) ||
    classifyShellSequence(inner.trim()) ||
    classifyPipelineSequence(inner.trim()) ||
    classifySimpleCommand(inner.trim());
  if (innerClassification.category === "blocked") return innerClassification;
  return { ...innerClassification, cdDir: dir, virtualWorkspacePath };
}

function configuredReadOnlyRoot(config = {}, dir = "") {
  const commandCwd = path.resolve(config.commandCwd || process.cwd());
  const candidate = path.resolve(commandCwd, String(dir || ""));
  const roots = (Array.isArray(config.readOnlyRoots) ? config.readOnlyRoots : [])
    .map((root) => path.resolve(String(root || "")))
    .filter(Boolean);
  return roots.find((root) => isInsideDirectory(root, candidate)) || "";
}

function classifyReadOnlyRootCd(normalized, config = {}) {
  const match = normalized.match(/^cd\s+([-\w./]+)(?:\s+(?:2>&1|1>&2|2>\/dev\/null|1>\/dev\/null|>\/dev\/null))?\s+&&\s+(.+)$/);
  if (!match) return null;
  const [, dir, inner] = match;
  const readOnlyRoot = configuredReadOnlyRoot(config, dir);
  if (!readOnlyRoot) return null;

  const innerClassification = classifyReadOnlyCompoundSequence(inner.trim()) ||
    classifyReadOnlyForLoop(inner.trim()) ||
    classifyShellSequence(inner.trim()) ||
    classifyPipelineSequence(inner.trim()) ||
    classifySimpleCommand(inner.trim());
  const safeCategory = ["read-only", "network-fetch"].includes(innerClassification.category);
  if (!safeCategory || innerClassification.writesWorkspace) {
    return {
      category: "blocked",
      reason: `Explicit read root permits inspection only; this command is not a bounded read-only check: ${inner.trim()}`,
      readOnlyRoot,
      cdDir: dir,
    };
  }
  return {
    ...innerClassification,
    writesWorkspace: false,
    cdDir: dir,
    readOnlyRoot,
    explicitReadOnlyRoot: true,
    reason: `Bounded ${innerClassification.category} check inside explicit read root: ${readOnlyRoot}`,
  };
}

function classifyReadOnlyRootSequence(normalized, config = {}) {
  const sequence = splitTopLevelShellSequence(normalized);
  if (!sequence) return null;
  const { parts } = sequence;
  const classifications = parts.map((part) => classifyReadOnlyRootCd(part, config));
  if (classifications.some((classification) => !classification)) return null;
  const blocked = classifications.find((classification) => classification.category === "blocked");
  if (blocked) return blocked;
  if (classifications.some((classification) => classification.writesWorkspace)) return null;
  if (!classifications.every((classification) => ["read-only", "network-fetch"].includes(classification.category))) {
    return null;
  }
  const readOnlyRoots = [...new Set(classifications.map((classification) => classification.readOnlyRoot).filter(Boolean))];
  return {
    category: classifications.some((classification) => classification.category === "network-fetch")
      ? "network-fetch"
      : "read-only",
    needsNetwork: classifications.some((classification) => classification.needsNetwork),
    writesWorkspace: false,
    explicitReadOnlyRoot: true,
    readOnlyRoot: readOnlyRoots.length === 1 ? readOnlyRoots[0] : "",
    readOnlyRoots,
    reason: `Bounded checks across explicit read roots: ${readOnlyRoots.join(", ")}`,
  };
}

export function classifyCommand(command) {
  const normalized = String(command || "").trim();
  if (!normalized) return { category: "blocked", reason: "Command is empty." };

  return classifyBackgroundShell(normalized) || classifyReadOnlyCompoundSequence(normalized) || classifyReadOnlyForLoop(normalized) || classifyCdCommand(normalized) || classifyShellSequence(normalized) || classifyPipelineSequence(normalized) || classifySimpleCommand(normalized);
}

export function evaluateCommandPolicy(command, config = {}) {
  const normalizedForPolicy = normalizeCommandForPolicy(command, config);
  const classification = classifyBackgroundShell(normalizedForPolicy) ||
    classifyReadOnlyRootCd(normalizedForPolicy, config) ||
    classifyReadOnlyRootSequence(normalizedForPolicy, config) ||
    classifyCommand(normalizedForPolicy);
  const normalizedCommand = String(command || "").trim();
  const sandboxMode = normalizeSandboxMode(config.sandboxMode);
  const packageInstallPolicy = normalizePackageInstallPolicy(config.packageInstallPolicy);
  const dockerWorkspace = sandboxMode === "docker-workspace";
  const packageInstallsAllowed = packageInstallPolicy === "allow";
  const trustedDockerShell = dockerWorkspace && packageInstallsAllowed;
  const trustedHostShell = sandboxMode === "host" && Boolean(config.allowDestructive);
  const trustedDangerHost = sandboxMode === "host" && Boolean(config.allowDestructive) && Boolean(config.allowPasswords);

  if (classification.category === "blocked") {
    if (trustedDangerHost && !isHardBlockedClassification(classification)) {
      return {
        allowed: true,
        ...classification,
        category: "general-shell",
        trustedDangerOverride: true,
        reason: `Trusted danger host mode allows this broad host command: ${classification.reason}`,
        sandboxMode,
        packageInstallPolicy,
      };
    }
    return { allowed: false, ...classification, sandboxMode, packageInstallPolicy };
  }

  if (classification.virtualWorkspacePath && !config.useDockerSandbox) {
    return {
      allowed: false,
      ...classification,
      reason: "Virtual /workspace shell paths are allowed only inside Docker sandbox mode.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (!config.allowShellTool) {
    return {
      allowed: false,
      category: classification.category,
      reason: "Shell tool is disabled for this run.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (classification.category === "unbounded-discovery") {
    return {
      allowed: false,
      ...classification,
      recoverable: true,
      needsApproval: false,
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (sandboxMode === "host" && /^sudo\b/.test(normalizedCommand) && !trustedDangerHost) {
    return {
      allowed: false,
      category: "host-sudo",
      needsApproval: true,
      reason:
        "Interactive host sudo is not run by AgInTiFlow because it can hang on password prompts or change the machine globally. Prefer project-local setup, Docker workspace mode, or return the exact manual install command for the user.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (classification.category === "system-package-install" && sandboxMode === "host" && !trustedDangerHost) {
    return {
      allowed: false,
      category: classification.category,
      needsApproval: true,
      reason:
        "Host OS package installs are not run automatically. Prefer an existing toolchain, project-local setup, Docker workspace mode, or report the exact manual command the user can run.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (
    classification.category === "package-install" ||
    classification.category === "env-setup" ||
    classification.category === "system-package-install"
  ) {
    if (packageInstallPolicy !== "allow") {
      return {
        allowed: false,
        category: classification.category,
        needsApproval: true,
        reason:
          packageInstallPolicy === "prompt"
            ? "Environment setup or package install requires explicit approval in the UI."
            : "Environment setup and package installs are blocked by policy.",
        sandboxMode,
        packageInstallPolicy,
      };
    }
  }

  if (classification.category === "general-shell" && !trustedDockerShell && !trustedHostShell) {
    return {
      allowed: false,
      ...classification,
      needsApproval: true,
      reason:
        sandboxMode === "host"
          ? "General shell commands on the host require Allow destructive actions. Prefer Docker workspace mode for broad shell access."
          : "General Docker shell commands require Package installs = allow in docker-workspace mode.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (classification.category === "permission-change" && sandboxMode !== "host" && !trustedDockerShell && !trustedHostShell) {
    return {
      allowed: false,
      ...classification,
      needsApproval: true,
      reason:
        sandboxMode === "host"
          ? "Workspace permission changes on the host require Allow destructive actions. Prefer Docker workspace mode."
          : "Docker permission changes require docker-workspace mode with Package installs = allow.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (classification.category === "destructive" && !config.allowDestructive) {
    return {
      allowed: false,
      ...classification,
      needsApproval: true,
      reason: "Destructive shell commands require Allow destructive actions.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (classification.needsNetwork && config.useDockerSandbox && !trustedDockerShell) {
    return {
      allowed: false,
      ...classification,
      needsApproval: true,
      reason: "Docker network commands require docker-workspace mode with Package installs = allow.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  if (classification.writesWorkspace && config.useDockerSandbox && sandboxMode !== "docker-workspace") {
    return {
      allowed: false,
      category: classification.category,
      reason: "Workspace-writing toolchain commands must run in Docker workspace-write sandbox mode.",
      sandboxMode,
      packageInstallPolicy,
    };
  }

  return {
    allowed: true,
    ...classification,
    requiresDockerRoot: Boolean(classification.requiresDockerRoot && config.useDockerSandbox),
    sandboxMode,
    packageInstallPolicy,
  };
}
