import type { SiteType } from "@/types/cloudpanel";
import type {
  ArchitectureDetection,
  DeploymentPlan,
  OperationAction,
  OperationActionGroup,
  OperationCheck,
  OperationFix,
  OperationStatus,
  OperationsData,
  RawOperationsData,
} from "@/types/operations";

type NormalizeOptions = {
  typeOverride?: SiteType;
  panelAdmin?: boolean;
};

const toolAvailable = (raw: RawOperationsData, id: string) =>
  Boolean(raw.tools?.[id]?.available);

function detection(
  id: string,
  kind: string,
  label: string,
  evidence: string[],
  framework?: string,
): ArchitectureDetection {
  return {
    id,
    kind,
    label,
    framework,
    confidence:
      evidence.length > 1 ? "high" : evidence.length ? "medium" : "low",
    evidence,
  };
}

function detections(raw: RawOperationsData, type: string) {
  const found: ArchitectureDetection[] = [];
  if (raw.hasCompose)
    found.push(
      detection("compose", "containers", "Docker Compose", [
        raw.compose?.file ?? "Compose manifest",
      ]),
    );
  if (raw.hasPackageJson)
    found.push(
      detection(
        "node",
        raw.hasWorkspace ? "node-workspace" : "node",
        raw.framework ||
          (raw.hasWorkspace ? "Node.js workspace" : "Node.js application"),
        [
          "package.json",
          ...(raw.packageManager?.lockfile
            ? [raw.packageManager.lockfile]
            : []),
          ...(raw.hasWorkspace ? ["workspace configuration"] : []),
        ],
        raw.framework || undefined,
      ),
    );
  if (raw.hasComposer || raw.hasArtisan || raw.hasWordPress)
    found.push(
      detection(
        raw.hasWordPress ? "wordpress" : raw.hasArtisan ? "laravel" : "php",
        "php",
        raw.hasWordPress
          ? "WordPress"
          : raw.hasArtisan
            ? "Laravel"
            : raw.framework || "PHP / Composer",
        [
          ...(raw.hasComposer ? ["composer.json"] : []),
          ...(raw.hasComposerLock ? ["composer.lock"] : []),
          ...(raw.hasArtisan ? ["artisan"] : []),
          ...(raw.hasWordPress ? ["wp-config.php"] : []),
        ],
        raw.framework || undefined,
      ),
    );
  if (
    raw.hasRequirements ||
    raw.hasPyproject ||
    raw.hasPipfile ||
    raw.hasManagePy
  )
    found.push(
      detection(
        raw.hasManagePy ? "django" : "python",
        "python",
        raw.hasManagePy ? "Django" : raw.framework || "Python application",
        [
          ...(raw.hasPyproject ? ["pyproject.toml"] : []),
          ...(raw.hasRequirements ? ["requirements.txt"] : []),
          ...(raw.hasPipfile ? ["Pipfile"] : []),
          ...(raw.hasManagePy ? ["manage.py"] : []),
        ],
        raw.framework || undefined,
      ),
    );
  if (raw.hasIndexHtml)
    found.push(detection("static", "static", "Static website", ["index.html"]));
  if (raw.reverseProxyUrl)
    found.push(
      detection("reverse-proxy", "proxy", "Reverse proxy", [
        "CloudPanel upstream URL",
      ]),
    );

  const preferred =
    type === "docker"
      ? "compose"
      : type === "nodejs"
        ? "node"
        : type === "php"
          ? raw.hasWordPress
            ? "wordpress"
            : raw.hasArtisan
              ? "laravel"
              : "php"
          : type === "python"
            ? raw.hasManagePy
              ? "django"
              : "python"
            : type === "static"
              ? raw.hasPackageJson
                ? "node"
                : "static"
              : type === "reverse-proxy"
                ? "reverse-proxy"
                : "";
  const primary =
    found.find((item) => item.id === preferred) ??
    found[0] ??
    detection(type || "generic", type || "generic", "Generic website", [
      "CloudPanel site type",
    ]);
  return {
    primary,
    alternatives: found.filter((item) => item.id !== primary.id),
  };
}

function check(
  id: string,
  label: string,
  available: boolean,
  readyDetail: string,
  blockedDetail: string,
  remediation?: string,
  options: { blocker?: boolean; warning?: boolean; fix?: OperationFix } = {},
): OperationCheck {
  return {
    id,
    label,
    status: available ? "ready" : options.warning ? "warning" : "blocked",
    detail: available ? readyDetail : blockedDetail,
    blocker: !available && options.blocker !== false && !options.warning,
    remediation: available ? undefined : remediation,
    fix: available ? undefined : options.fix,
  };
}

// Host-root fixes change shared server state, so they carry the same Super
// Admin boundary as rootful Docker. Site-scoped fixes only edit files inside
// the site root, so they need the ordinary Operations permission instead.
function makeFix(
  raw: RawOperationsData,
  fix: Omit<OperationFix, "status" | "blockedBy">,
): OperationFix {
  const hostRoot = fix.scope === "host-root";
  const authorized = hostRoot
    ? Boolean(raw.permissions?.docker)
    : Boolean(raw.permissions?.manage);
  const blockedBy = authorized
    ? []
    : [
        hostRoot
          ? "Host software changes require a Super Admin."
          : "Operations permission is required.",
      ];
  return { ...fix, blockedBy, status: statusFrom(blockedBy, authorized) };
}

const FIXES: Record<
  OperationFix["id"],
  Omit<OperationFix, "status" | "blockedBy">
> = {
  "install-docker": {
    id: "install-docker",
    label: "Install Docker Engine",
    description:
      "Install the latest Docker Engine, CLI, and Compose v2 plugin from Docker's official repository.",
    risk: "disruptive",
    scope: "host-root",
    confirmation: {
      title: "Install Docker Engine on this server?",
      message:
        "Panelavo will configure Docker's official APT repository and install the latest Docker Engine, CLI, Buildx, and Compose v2 plugin, then start the daemon. This changes host-level software.",
      confirmText: "Install Docker",
    },
  },
  "install-compose-plugin": {
    id: "install-compose-plugin",
    label: "Install Compose v2 plugin",
    description:
      "Install the latest Docker Compose v2 plugin from Docker's official repository.",
    risk: "disruptive",
    scope: "host-root",
    confirmation: {
      title: "Install the Docker Compose v2 plugin?",
      message:
        "Panelavo will configure Docker's official APT repository and install the latest Compose v2 and Buildx plugins. This changes host-level software.",
      confirmText: "Install plugin",
    },
  },
  "start-docker": {
    id: "start-docker",
    label: "Start Docker daemon",
    description: "Enable and start the Docker system service.",
    risk: "disruptive",
    scope: "host-root",
    confirmation: {
      title: "Start the Docker daemon?",
      message:
        "Panelavo will enable and start the docker system service so it also survives reboots.",
      confirmText: "Start Docker",
    },
  },
  "install-composer": {
    id: "install-composer",
    label: "Install Composer",
    description:
      "Install the latest Composer release from getcomposer.org with installer signature verification.",
    risk: "disruptive",
    scope: "host-root",
    confirmation: {
      title: "Install Composer on this server?",
      message:
        "Panelavo will download the latest Composer installer from getcomposer.org, verify its signature, and install it to /usr/local/bin/composer.",
      confirmText: "Install Composer",
    },
  },
};

function preflightChecks(raw: RawOperationsData, type: string) {
  const checks: OperationCheck[] = [
    check(
      "project-root",
      "Application root",
      Boolean(raw.path),
      raw.path || "Application root resolved",
      "The configured application root could not be resolved.",
      "Review the website document root in Settings.",
    ),
    check(
      "permission",
      "Operations permission",
      Boolean(raw.permissions?.manage),
      "You can run site-user operations.",
      "Your role has read-only access to Operations.",
      "Ask a Panelavo Admin, Manager, or Super Admin to run this operation.",
    ),
  ];

  if (type === "docker") {
    checks.push(
      check(
        "compose-file",
        "Compose configuration",
        Boolean(raw.hasCompose && raw.compose?.file),
        raw.compose?.file ?? "Compose configuration found",
        "No supported Compose file exists in the application root.",
        "Add compose.yaml, compose.yml, docker-compose.yaml, or docker-compose.yml.",
      ),
      check(
        "docker-cli",
        "Docker CLI",
        Boolean(raw.compose?.cliAvailable),
        raw.tools?.docker?.version
          ? `Docker ${raw.tools.docker.version}`
          : "Docker executable is available.",
        "The Docker executable is not installed on this server.",
        "Install Docker Engine from Docker's official repository as a root administrator.",
        { fix: makeFix(raw, FIXES["install-docker"]) },
      ),
      check(
        "compose-plugin",
        "Compose plugin",
        Boolean(raw.compose?.pluginAvailable),
        raw.compose?.version
          ? `Docker Compose ${raw.compose.version}`
          : "Docker Compose v2 is available.",
        "The Docker Compose v2 plugin is unavailable.",
        "Install the docker-compose-plugin package and run the preflight again.",
        {
          fix: makeFix(
            raw,
            FIXES[
              raw.compose?.cliAvailable
                ? "install-compose-plugin"
                : "install-docker"
            ],
          ),
        },
      ),
      check(
        "docker-daemon",
        "Docker daemon",
        Boolean(raw.compose?.daemonAvailable),
        "The Docker daemon is reachable.",
        "The Docker daemon is stopped or unreachable.",
        "Start Docker and verify it with docker info.",
        {
          fix:
            raw.compose?.cliAvailable && raw.compose?.pluginAvailable
              ? makeFix(raw, FIXES["start-docker"])
              : undefined,
        },
      ),
      check(
        "compose-config",
        "Compose validation",
        raw.compose?.configValid === true,
        `${raw.compose?.services?.length ?? 0} service(s) validated.`,
        raw.compose?.detail ||
          "The Compose configuration could not be validated.",
        "Resolve Compose interpolation and schema errors, then run the preflight again.",
      ),
      check(
        "compose-safety",
        "Host safety policy",
        raw.compose?.safe === true,
        "No unsafe root-level Compose features were detected.",
        raw.compose?.detail ||
          "The Compose configuration uses a host-level feature Panelavo will not run as root.",
        "Use loopback-only ports and keep bind mounts, build contexts, configs, and secrets inside the site root.",
        {},
      ),
      {
        id: "entry-port",
        label: "Website entry port",
        status:
          raw.compose?.configValid !== true
            ? "warning"
            : raw.compose?.portMatches
              ? "ready"
              : raw.compose?.canAutoRemap
                ? "warning"
                : "blocked",
        detail:
          raw.compose?.configValid !== true
            ? "Entry-service and port matching will run after the Compose configuration can be resolved."
            : raw.compose?.portDetail ||
              "Panelavo could not match a Compose service to CloudPanel's configured upstream port.",
        blocker:
          raw.compose?.configValid === true &&
          !raw.compose?.portMatches &&
          !raw.compose?.canAutoRemap,
        remediation:
          raw.compose?.configValid !== true ||
          raw.compose?.portMatches ||
          raw.compose?.canAutoRemap
            ? undefined
            : "Label exactly one service io.panelavo.entrypoint=true and, when it exposes multiple container ports, set io.panelavo.container-port=<port>.",
      },
      check(
        "docker-permission",
        "Root deployment approval",
        Boolean(raw.permissions?.docker),
        "Super Admin approval is available.",
        "Rootful Docker deployment is restricted to Super Admins.",
        "Ask a Super Admin to review and deploy this Compose project.",
      ),
    );
  } else if (type === "nodejs" || (type === "static" && raw.hasPackageJson)) {
    checks.push(
      check(
        "package-json",
        "Node.js manifest",
        Boolean(raw.hasPackageJson),
        "package.json found.",
        "package.json is missing from the configured application root.",
      ),
      check(
        "package-manager",
        Boolean(raw.packageManager?.label)
          ? raw.packageManager!.label
          : "Package manager",
        Boolean(
          raw.packageManager &&
          !raw.packageManager.ambiguous &&
          raw.packageManager.available,
        ),
        `${raw.packageManager?.label ?? "Package manager"}${raw.packageManager?.lockfile ? ` · ${raw.packageManager.lockfile}` : ""}`,
        raw.packageManager?.detail ||
          "No unambiguous, available package manager could be selected.",
        "Keep one lockfile, declare packageManager in package.json, and install that exact manager.",
      ),
    );
    if (type === "nodejs") {
      checks.push(
        check(
          "start-script",
          "Production entry point",
          Boolean(raw.hasStartScript || raw.hasEcosystem),
          raw.hasEcosystem
            ? "PM2 ecosystem file found."
            : "Production start script found.",
          "No start script or PM2 ecosystem file was detected.",
          "Add a production start script or ecosystem.config file; development servers are not deployed.",
        ),
        check(
          "pm2",
          "Process manager",
          toolAvailable(raw, "pm2"),
          "PM2 is available to the site user.",
          "PM2 is unavailable to the site user.",
          "Install the shared PM2 runtime using the Panelavo provisioning workflow.",
        ),
      );
    } else {
      checks.push(
        check(
          "build-script",
          "Production build",
          Boolean(raw.hasBuildScript),
          "A production build script was detected.",
          "The static project has no build script.",
          "Add an explicit production build script and configure CloudPanel to serve its output directory.",
        ),
      );
    }
  } else if (type === "php") {
    checks.push(
      check(
        "php-runtime",
        "PHP CLI",
        toolAvailable(raw, "php"),
        "PHP is available.",
        "PHP CLI is unavailable.",
      ),
    );
    if (raw.hasComposer) {
      checks.push(
        check(
          "composer",
          "Composer",
          toolAvailable(raw, "composer"),
          "Composer is available.",
          "Composer is unavailable.",
          "Install Composer system-wide or through CloudPanel.",
          { fix: makeFix(raw, FIXES["install-composer"]) },
        ),
        check(
          "composer-lock",
          "Locked PHP dependencies",
          Boolean(raw.hasComposerLock),
          "composer.lock found.",
          "composer.lock is missing; a deterministic production install is not possible.",
          "Commit composer.lock before deploying.",
        ),
      );
    }
    if (raw.hasArtisan && !raw.hasEnvFile)
      checks.push(
        check(
          "laravel-env",
          "Laravel environment",
          false,
          ".env found.",
          ".env was not found in the application root.",
          "Create the production .env as the site user; never commit it.",
          { warning: true },
        ),
      );
  } else if (type === "python") {
    checks.push(
      check(
        "python-runtime",
        "Python runtime",
        toolAvailable(raw, "python"),
        "Python is available.",
        "Python is unavailable to the site user.",
      ),
      check(
        "python-manager",
        raw.pythonManager?.label || "Python dependencies",
        Boolean(
          raw.pythonManager &&
          !raw.pythonManager.ambiguous &&
          raw.pythonManager.available,
        ),
        `${raw.pythonManager?.label ?? "Python dependency manager"}${raw.pythonManager?.lockfile ? ` · ${raw.pythonManager.lockfile}` : ""}`,
        raw.pythonManager?.detail ||
          "No supported Python dependency manifest and tool were found.",
        "Use uv.lock, poetry.lock, Pipfile.lock, requirements.txt, or pyproject.toml with its matching tool.",
      ),
    );
  } else if (type === "static") {
    checks.push(
      check(
        "static-entry",
        "Static entry point",
        Boolean(raw.hasIndexHtml),
        "index.html is served directly from the configured root.",
        "No index.html was found in the configured static root.",
        "Upload a built static site or point the document root at its verified output directory.",
      ),
    );
  } else if (type === "reverse-proxy") {
    checks.push(
      check(
        "upstream",
        "Upstream target",
        Boolean(raw.reverseProxyUrl),
        raw.reverseProxyUrl || "Upstream configured.",
        "No upstream URL is configured.",
        "Configure the reverse-proxy URL in Settings.",
      ),
    );
  }
  if (["nodejs", "python"].includes(type) && raw.port?.expected) {
    checks.push(
      check(
        "runtime-port",
        "Application listening port",
        raw.port.listening,
        raw.port.detail,
        raw.port.detail,
        `The deployment will provide PORT=${raw.port.expected} and verify 127.0.0.1:${raw.port.expected}. If an ecosystem file overrides PORT, update it to match CloudPanel.`,
        { warning: true },
      ),
    );
  } else if (type === "reverse-proxy" && raw.port?.expected) {
    checks.push(
      check(
        "upstream-port",
        "Reverse-proxy upstream",
        raw.port.listening,
        raw.port.detail,
        raw.port.detail,
        `Start the upstream on 127.0.0.1:${raw.port.expected}, or change the reverse-proxy URL in Settings.`,
      ),
    );
  }
  return checks;
}

function statusFrom(blockedBy: string[], authorized: boolean): OperationStatus {
  if (!authorized) return "unauthorized";
  return blockedBy.length ? "blocked" : "ready";
}

function makeAction(
  raw: RawOperationsData,
  action: Omit<OperationAction, "status" | "blockedBy"> & {
    blockers?: string[];
    docker?: boolean;
  },
): OperationAction {
  const authorized =
    Boolean(raw.permissions?.manage) &&
    (!action.docker || Boolean(raw.permissions?.docker));
  const blockedBy = [...(action.blockers ?? [])];
  if (!raw.permissions?.manage)
    blockedBy.unshift("Operations permission is required.");
  else if (action.docker && !raw.permissions?.docker)
    blockedBy.unshift("Rootful Docker operations require a Super Admin.");
  const rest = { ...action };
  delete rest.blockers;
  delete rest.docker;
  return { ...rest, blockedBy, status: statusFrom(blockedBy, authorized) };
}

function actionGroups(
  raw: RawOperationsData,
  type: string,
): OperationActionGroup[] {
  const groups: OperationActionGroup[] = [];
  const dependencyActions: OperationAction[] = [];
  const runtimeActions: OperationAction[] = [];
  const frameworkActions: OperationAction[] = [];
  const diagnosticActions: OperationAction[] = [];

  if (raw.hasPackageJson) {
    const managerBlockers = [
      ...(raw.packageManager?.ambiguous
        ? [
            raw.packageManager.detail ||
              "Package manager selection is ambiguous.",
          ]
        : []),
      ...(!raw.packageManager?.available
        ? [
            `${raw.packageManager?.label || "The package manager"} is unavailable.`,
          ]
        : []),
    ];
    dependencyActions.push(
      makeAction(raw, {
        id: "node-install",
        group: "dependencies",
        label: `Install with ${raw.packageManager?.label || "package manager"}`,
        description: raw.packageManager?.lockfile
          ? `Use the locked dependencies from ${raw.packageManager.lockfile}.`
          : "Install the declared Node.js dependencies.",
        iconKey: "package",
        commandPreview: raw.packageManager?.detail,
        risk: "disruptive",
        scope: "site-user",
        blockers: managerBlockers,
        confirmation: {
          title: "Install Node.js dependencies?",
          message:
            "This changes the dependency tree in the configured application root and may replace node_modules.",
          confirmText: "Install dependencies",
        },
      }),
    );
    for (const script of raw.scripts ?? []) {
      frameworkActions.push(
        makeAction(raw, {
          id: "node-run",
          group: "scripts",
          label: `${raw.packageManager?.label || "Node"} · ${script.name}`,
          description:
            script.command.length > 90
              ? `${script.command.slice(0, 90)}…`
              : script.command,
          iconKey: script.name === "build" ? "build" : "terminal",
          commandPreview: script.command,
          risk: script.name === "build" ? "disruptive" : "safe",
          scope: "site-user",
          input: { script: script.name },
          blockers: managerBlockers,
          ...(script.name === "build"
            ? {
                confirmation: {
                  title: "Run the production build?",
                  message:
                    "The declared build script can replace generated application files.",
                  confirmText: "Run build",
                },
              }
            : {}),
        }),
      );
    }
  }

  if (raw.hasComposer) {
    const blockers = [
      ...(!toolAvailable(raw, "composer") ? ["Composer is unavailable."] : []),
      ...(!raw.hasComposerLock
        ? ["composer.lock is required for a deterministic production install."]
        : []),
    ];
    dependencyActions.push(
      makeAction(raw, {
        id: "composer-install-production",
        group: "dependencies",
        label: "Install PHP dependencies",
        description: "Locked production install without development packages.",
        iconKey: "package",
        commandPreview:
          "composer install --no-dev --prefer-dist --optimize-autoloader",
        risk: "disruptive",
        scope: "site-user",
        blockers,
        confirmation: {
          title: "Install production PHP dependencies?",
          message:
            "Composer will synchronize vendor/ to composer.lock and remove development-only packages.",
          confirmText: "Run Composer install",
        },
      }),
    );
    diagnosticActions.push(
      makeAction(raw, {
        id: "composer-validate",
        group: "diagnostics",
        label: "Validate Composer files",
        description:
          "Check composer.json and composer.lock without changing dependencies.",
        iconKey: "check",
        commandPreview: "composer validate --no-check-publish",
        risk: "safe",
        scope: "site-user",
        blockers: !toolAvailable(raw, "composer")
          ? ["Composer is unavailable."]
          : [],
      }),
    );
  }

  if (raw.hasRequirements || raw.hasPyproject || raw.hasPipfile) {
    const pythonBlockers = [
      ...(!toolAvailable(raw, "python") ? ["Python is unavailable."] : []),
      ...(raw.pythonManager?.ambiguous
        ? [
            raw.pythonManager.detail ||
              "Python dependency selection is ambiguous.",
          ]
        : []),
      ...(!raw.pythonManager?.available
        ? [
            `${raw.pythonManager?.label || "The Python dependency manager"} is unavailable.`,
          ]
        : []),
    ];
    if (raw.pythonManager?.id === "pip" && !raw.hasPythonVenv)
      dependencyActions.push(
        makeAction(raw, {
          id: "python-create-venv",
          group: "dependencies",
          label: "Create virtual environment",
          description: "Create an isolated .venv owned by the site user.",
          iconKey: "package",
          commandPreview: "python3 -m venv .venv",
          risk: "safe",
          scope: "site-user",
          blockers: !toolAvailable(raw, "python")
            ? ["Python is unavailable."]
            : [],
        }),
      );
    dependencyActions.push(
      makeAction(raw, {
        id: "python-install",
        group: "dependencies",
        label: `Sync with ${raw.pythonManager?.label || "Python"}`,
        description:
          "Install the detected Python dependency definition into an isolated environment.",
        iconKey: "package",
        commandPreview: raw.pythonManager?.detail,
        risk: "disruptive",
        scope: "site-user",
        blockers: [
          ...pythonBlockers,
          ...(raw.pythonManager?.id === "pip" && !raw.hasPythonVenv
            ? ["Create .venv before installing dependencies."]
            : []),
        ],
        confirmation: {
          title: "Synchronize Python dependencies?",
          message:
            "This changes packages inside the application's isolated environment.",
          confirmText: "Sync dependencies",
        },
      }),
    );
  }

  if (raw.hasArtisan) {
    const phpBlockers = !toolAvailable(raw, "php")
      ? ["PHP is unavailable."]
      : [];
    frameworkActions.push(
      makeAction(raw, {
        id: "artisan-optimize",
        group: "framework",
        label: "Build Laravel caches",
        description:
          "Cache production configuration, events, routes, and views.",
        iconKey: "cache",
        commandPreview: "php artisan optimize",
        risk: "disruptive",
        scope: "site-user",
        blockers: phpBlockers,
      }),
      makeAction(raw, {
        id: "artisan-optimize-clear",
        group: "framework",
        label: "Clear Laravel caches",
        description:
          "Remove generated Laravel caches after configuration changes.",
        iconKey: "refresh",
        commandPreview: "php artisan optimize:clear",
        risk: "disruptive",
        scope: "site-user",
        blockers: phpBlockers,
      }),
      makeAction(raw, {
        id: "artisan-migrate-status",
        group: "framework",
        label: "Migration status",
        description:
          "Review pending database migrations without applying them.",
        iconKey: "database",
        commandPreview: "php artisan migrate:status",
        risk: "safe",
        scope: "site-user",
        blockers: phpBlockers,
      }),
      makeAction(raw, {
        id: "artisan-migrate",
        group: "framework",
        label: "Apply migrations",
        description: "Apply pending production database migrations.",
        iconKey: "database",
        commandPreview: "php artisan migrate --force",
        risk: "destructive",
        scope: "site-user",
        blockers: phpBlockers,
        confirmation: {
          title: "Apply database migrations?",
          message:
            "Back up the database first. Code rollback does not automatically roll back database changes.",
          confirmText: "Apply migrations",
        },
      }),
      makeAction(raw, {
        id: "artisan-storage-link",
        group: "framework",
        label: "Create storage link",
        description: "Create Laravel's public storage symbolic link.",
        iconKey: "play",
        commandPreview: "php artisan storage:link",
        risk: "safe",
        scope: "site-user",
        blockers: phpBlockers,
      }),
      makeAction(raw, {
        id: "artisan-queue-restart",
        group: "framework",
        label: "Restart queue workers",
        description:
          "Ask Laravel queue workers to restart after their current job.",
        iconKey: "refresh",
        commandPreview: "php artisan queue:restart",
        risk: "disruptive",
        scope: "site-user",
        blockers: phpBlockers,
        confirmation: {
          title: "Restart Laravel queue workers?",
          message:
            "Workers will finish their current job, then exit for their supervisor to restart.",
          confirmText: "Restart workers",
        },
      }),
    );
  }

  if (raw.hasSymfonyConsole) {
    frameworkActions.push(
      makeAction(raw, {
        id: "symfony-cache-clear",
        group: "framework",
        label: "Clear Symfony cache",
        description: "Rebuild the production Symfony cache.",
        iconKey: "cache",
        commandPreview: "php bin/console cache:clear --env=prod --no-debug",
        risk: "disruptive",
        scope: "site-user",
        blockers: !toolAvailable(raw, "php") ? ["PHP is unavailable."] : [],
      }),
    );
  }

  if (raw.hasWordPress) {
    const wpBlockers = !toolAvailable(raw, "wp")
      ? ["WP-CLI is unavailable."]
      : [];
    diagnosticActions.push(
      makeAction(raw, {
        id: "wp-core-checksums",
        group: "diagnostics",
        label: "Verify WordPress core",
        description:
          "Compare core files with the official WordPress checksums.",
        iconKey: "check",
        commandPreview: "wp core verify-checksums",
        risk: "safe",
        scope: "site-user",
        blockers: wpBlockers,
      }),
    );
    frameworkActions.push(
      makeAction(raw, {
        id: "wp-cache-flush",
        group: "framework",
        label: "Flush WordPress cache",
        description: "Flush the object cache through WP-CLI.",
        iconKey: "cache",
        commandPreview: "wp cache flush",
        risk: "disruptive",
        scope: "site-user",
        blockers: wpBlockers,
        confirmation: {
          title: "Flush the WordPress object cache?",
          message:
            "The next requests may be slower while cached objects are rebuilt.",
          confirmText: "Flush cache",
        },
      }),
      makeAction(raw, {
        id: "wp-cron-run",
        group: "framework",
        label: "Run due WordPress cron events",
        description: "Run only currently due events through WP-CLI.",
        iconKey: "play",
        commandPreview: "wp cron event run --due-now",
        risk: "disruptive",
        scope: "site-user",
        blockers: wpBlockers,
        confirmation: {
          title: "Run due WordPress cron events?",
          message:
            "Plugins may perform email, publishing, cleanup, or other scheduled work.",
          confirmText: "Run due events",
        },
      }),
    );
  }

  if (raw.hasManagePy) {
    const blockers = [
      ...(!toolAvailable(raw, "python") ? ["Python is unavailable."] : []),
      ...(raw.pythonManager?.id === "pip" && !raw.hasPythonVenv
        ? ["Create .venv before running Django commands."]
        : []),
    ];
    diagnosticActions.push(
      makeAction(raw, {
        id: "django-check-deploy",
        group: "diagnostics",
        label: "Django deployment check",
        description:
          "Run Django's production security and configuration checks.",
        iconKey: "check",
        commandPreview: "python manage.py check --deploy",
        risk: "safe",
        scope: "site-user",
        blockers,
      }),
      makeAction(raw, {
        id: "django-migrate-status",
        group: "diagnostics",
        label: "Django migration plan",
        description: "Show pending migration operations without applying them.",
        iconKey: "database",
        commandPreview: "python manage.py migrate --plan",
        risk: "safe",
        scope: "site-user",
        blockers,
      }),
    );
    frameworkActions.push(
      makeAction(raw, {
        id: "django-migrate",
        group: "framework",
        label: "Apply Django migrations",
        description: "Apply pending database migrations.",
        iconKey: "database",
        commandPreview: "python manage.py migrate --noinput",
        risk: "destructive",
        scope: "site-user",
        blockers,
        confirmation: {
          title: "Apply Django database migrations?",
          message:
            "Back up the database first. Code rollback does not automatically reverse migrations.",
          confirmText: "Apply migrations",
        },
      }),
      makeAction(raw, {
        id: "django-collectstatic",
        group: "framework",
        label: "Collect Django static files",
        description:
          "Replace the configured static output with collected production assets.",
        iconKey: "build",
        commandPreview: "python manage.py collectstatic --noinput",
        risk: "disruptive",
        scope: "site-user",
        blockers,
        confirmation: {
          title: "Collect Django static files?",
          message: "Files in STATIC_ROOT may be replaced.",
          confirmText: "Collect static files",
        },
      }),
    );
  }

  if (type === "docker" || raw.hasCompose) {
    const configBlockers = [
      ...(!raw.hasCompose ? ["No Compose file was found."] : []),
      ...(!raw.compose?.cliAvailable ? ["Docker CLI is unavailable."] : []),
      ...(!raw.compose?.pluginAvailable
        ? ["Docker Compose v2 is unavailable."]
        : []),
      ...(raw.compose?.configValid !== true
        ? [raw.compose?.detail || "The Compose configuration is invalid."]
        : []),
      ...(raw.compose?.safe !== true
        ? [
            raw.compose?.detail ||
              "The Compose configuration failed the host safety policy.",
          ]
        : []),
    ];
    const daemonBlockers = [
      ...configBlockers,
      ...(!raw.compose?.daemonAvailable
        ? ["The Docker daemon is unavailable."]
        : []),
    ];
    runtimeActions.push(
      makeAction(raw, {
        id: "compose-validate",
        group: "containers",
        label: "Validate configuration",
        description: `Validate ${raw.compose?.file || "the selected Compose file"} without starting services.`,
        iconKey: "check",
        commandPreview: "docker compose config --quiet",
        risk: "safe",
        scope: "host-root",
        blockers: configBlockers.filter(
          (item) => !item.includes("invalid") && !item.includes("safety"),
        ),
        docker: true,
      }),
      makeAction(raw, {
        id: "compose-up",
        group: "containers",
        label: "Start services",
        description: "Create or start the selected Compose services.",
        iconKey: "play",
        commandPreview: "docker compose up -d",
        risk: "disruptive",
        scope: "host-root",
        blockers: daemonBlockers,
        docker: true,
        confirmation: {
          title: "Start the Compose project as root?",
          message:
            "Panelavo will run the reviewed Compose configuration through the host Docker daemon.",
          confirmText: "Start services",
        },
      }),
      makeAction(raw, {
        id: "compose-deploy",
        group: "containers",
        label: "Build & start services",
        description:
          "Build or rebuild images, then create or restart the selected Compose services.",
        iconKey: "build",
        commandPreview: "docker compose up -d --build --remove-orphans",
        risk: "disruptive",
        scope: "host-root",
        blockers: daemonBlockers,
        docker: true,
        confirmation: {
          title: "Build and start the Compose project as root?",
          message:
            "Panelavo will rebuild images from the reviewed Compose configuration, recreate services when required, remove orphaned project containers, and verify the website entry port.",
          confirmText: "Build & start",
        },
      }),
      makeAction(raw, {
        id: "compose-restart",
        group: "containers",
        label: "Restart services",
        description: "Restart all services in this Compose project.",
        iconKey: "refresh",
        commandPreview: "docker compose restart",
        risk: "disruptive",
        scope: "host-root",
        blockers: daemonBlockers,
        docker: true,
        confirmation: {
          title: "Restart all Compose services?",
          message:
            "The website may be briefly unavailable while its containers restart.",
          confirmText: "Restart services",
        },
      }),
      makeAction(raw, {
        id: "compose-pull",
        group: "containers",
        label: "Pull service images",
        description:
          "Pull image-backed services without failing on build-only services.",
        iconKey: "refresh",
        commandPreview: "docker compose pull --ignore-buildable",
        risk: "disruptive",
        scope: "host-root",
        blockers: daemonBlockers,
        docker: true,
        confirmation: {
          title: "Pull new container images?",
          message:
            "Images are downloaded but running services are not replaced until they are deployed.",
          confirmText: "Pull images",
        },
      }),
      makeAction(raw, {
        id: "compose-ps",
        group: "containers",
        label: "Service status",
        description: "Show current service, port, and health state.",
        iconKey: "box",
        commandPreview: "docker compose ps",
        risk: "safe",
        scope: "host-root",
        blockers: daemonBlockers,
        docker: true,
      }),
      makeAction(raw, {
        id: "compose-logs",
        group: "containers",
        label: "Recent service logs",
        description: "Show the last 200 lines without attaching to containers.",
        iconKey: "logs",
        commandPreview: "docker compose logs --tail 200 --no-color",
        risk: "safe",
        scope: "host-root",
        blockers: daemonBlockers,
        docker: true,
      }),
      makeAction(raw, {
        id: "compose-down",
        group: "containers",
        label: "Stop project",
        description:
          "Stop services and remove project containers and networks; named volumes are kept.",
        iconKey: "stop",
        commandPreview: "docker compose down",
        risk: "destructive",
        scope: "host-root",
        blockers: daemonBlockers,
        docker: true,
        confirmation: {
          title: "Stop the entire Compose project?",
          message:
            "All project services will go offline. Named volumes are preserved.",
          confirmText: "Stop project",
        },
      }),
    );
  }

  if (raw.hasEcosystem || raw.hasStartScript || raw.pm2?.length) {
    const blockers = [
      ...(!toolAvailable(raw, "pm2") ? ["PM2 is unavailable."] : []),
      ...(!raw.hasEcosystem && !raw.hasStartScript
        ? ["No ecosystem file or start script was found."]
        : []),
    ];
    runtimeActions.push(
      makeAction(raw, {
        id: "pm2-start",
        group: "processes",
        label: raw.hasEcosystem
          ? "Start or reload ecosystem"
          : "Start or reload application",
        description: raw.hasEcosystem
          ? "Apply the repository's PM2 ecosystem declaration."
          : "Run the selected package manager's production start script under PM2.",
        iconKey: "play",
        commandPreview: raw.hasEcosystem
          ? "pm2 startOrReload ecosystem.config.*"
          : "pm2 start <manager> -- start",
        risk: "disruptive",
        scope: "site-user",
        blockers,
        confirmation: {
          title: "Start or reload the application process?",
          message:
            "The active application process may restart while PM2 applies the new declaration.",
          confirmText: "Start or reload",
        },
      }),
      makeAction(raw, {
        id: "pm2-logs",
        group: "processes",
        label: "Recent PM2 logs",
        description:
          "Show the last 200 lines without attaching to the process.",
        iconKey: "logs",
        commandPreview: "pm2 logs --nostream --lines 200",
        risk: "safe",
        scope: "site-user",
        blockers: !toolAvailable(raw, "pm2") ? ["PM2 is unavailable."] : [],
      }),
      makeAction(raw, {
        id: "pm2-save",
        group: "processes",
        label: "Save process list",
        description:
          "Persist the current site-user process list for reboot recovery.",
        iconKey: "check",
        commandPreview: "pm2 save --force",
        risk: "safe",
        scope: "site-user",
        blockers: !toolAvailable(raw, "pm2") ? ["PM2 is unavailable."] : [],
      }),
    );
  }

  if (type === "reverse-proxy" && raw.reverseProxyUrl) {
    diagnosticActions.push(
      makeAction(raw, {
        id: "upstream-check",
        group: "diagnostics",
        label: "Check upstream",
        description: "Request the configured upstream with a bounded timeout.",
        iconKey: "check",
        commandPreview: `curl ${raw.reverseProxyUrl}`,
        risk: "safe",
        scope: "site-user",
        blockers: !toolAvailable(raw, "curl") ? ["curl is unavailable."] : [],
      }),
    );
  }

  const definitions: [string, string, string, OperationAction[]][] =
    type === "docker"
      ? [
          [
            "runtime",
            "Runtime & lifecycle",
            "Targeted controls for this website's Compose project.",
            runtimeActions.filter((action) => action.id.startsWith("compose-")),
          ],
        ]
      : [
          [
            "dependencies",
            "Dependencies",
            "Deterministic installs selected from manifests and lockfiles.",
            dependencyActions,
          ],
          [
            "scripts",
            "Build & application tasks",
            "Allow-listed scripts detected in the application manifest.",
            frameworkActions,
          ],
          [
            "runtime",
            "Runtime & lifecycle",
            "Targeted controls for this website's process or Compose project.",
            runtimeActions,
          ],
          [
            "diagnostics",
            "Diagnostics",
            "Read-only validation and production readiness checks.",
            diagnosticActions,
          ],
        ];
  for (const [id, title, description, actions] of definitions)
    if (actions.length) groups.push({ id, title, description, actions });
  return groups;
}

function blockersForChecks(checks: OperationCheck[]) {
  return checks.filter((item) => item.blocker).map((item) => item.detail);
}

function planFor(
  raw: RawOperationsData,
  type: string,
  checks: OperationCheck[],
): DeploymentPlan | undefined {
  const authorized = Boolean(raw.permissions?.manage);
  const commonBlockers = blockersForChecks(checks);
  const warnings = [
    ...(raw.hasWorkspace
      ? [
          "Workspace operations run from the configured root; Panelavo never guesses a nested deployable application.",
        ]
      : []),
    ...(raw.compose?.warnings ?? []),
    ...(raw.compose?.canAutoRemap && raw.compose.portDetail
      ? [raw.compose.portDetail]
      : []),
    ...(["nodejs", "python"].includes(type) &&
    raw.port?.expected &&
    !raw.port.listening
      ? [raw.port.detail]
      : []),
  ];
  const finish = (
    plan: Omit<DeploymentPlan, "status" | "blockedBy" | "warnings"> & {
      blockers?: string[];
      warnings?: string[];
    },
  ): DeploymentPlan => {
    const blockedBy = [...commonBlockers, ...(plan.blockers ?? [])];
    const planWarnings = plan.warnings;
    const rest = { ...plan };
    delete rest.blockers;
    delete rest.warnings;
    return {
      ...rest,
      blockedBy: [...new Set(blockedBy)],
      warnings: [...new Set([...warnings, ...(planWarnings ?? [])])],
      status: statusFrom(
        blockedBy,
        authorized &&
          (rest.id !== "compose" || Boolean(raw.permissions?.docker)),
      ),
    };
  };

  if (type === "docker") {
    return finish({
      id: "compose",
      label: "Validate and deploy Compose project",
      description:
        "Validate the selected file, build or recreate services, then report their final state.",
      risk: "disruptive",
      scope: "host-root",
      steps: [
        {
          command: "compose-validate",
          label: "Validate configuration",
          description: "Resolve and validate the selected Compose model.",
        },
        {
          command: "compose-deploy",
          label: "Build and start services",
          description: "Run the reviewed project in detached mode.",
        },
        {
          command: "compose-ps",
          label: "Verify service state",
          description: "Report containers, ports, and available health state.",
        },
        ...(raw.compose?.expectedPort
          ? [
              {
                command: "compose-port-verify",
                label: "Verify website entry port",
                description:
                  "Confirm CloudPanel can connect to the expected loopback port.",
              },
            ]
          : []),
      ],
      confirmation: {
        title: "Deploy this Compose project as root?",
        message:
          "Panelavo will execute the reviewed, site-contained Compose configuration through the host Docker daemon. Existing services may restart.",
        confirmText: "Deploy project",
      },
    });
  }

  if (type === "nodejs" && raw.hasPackageJson) {
    const steps = [
      {
        command: "node-install",
        label: `Install with ${raw.packageManager?.label || "package manager"}`,
        description: "Synchronize locked dependencies.",
      },
      ...(raw.hasBuildScript
        ? [
            {
              command: "node-run:build",
              label: "Build application",
              description: "Run the declared production build.",
            },
          ]
        : []),
      {
        command: "pm2-start",
        label: "Start or reload process",
        description: "Apply the exact site process declaration.",
      },
      {
        command: "pm2-save",
        label: "Persist process state",
        description: "Save the site-user PM2 process list.",
      },
      ...(raw.expectedPort
        ? [
            {
              command: "runtime-port-verify",
              label: "Verify application port",
              description:
                "Confirm the app accepts traffic on CloudPanel's configured port.",
            },
          ]
        : []),
    ];
    return finish({
      id: "node",
      label: "Build and deploy Node.js application",
      description:
        "Use the detected lockfile and package manager, build when declared, then reload the site process.",
      risk: "disruptive",
      scope: "site-user",
      steps,
      confirmation: {
        title: "Deploy the Node.js application?",
        message:
          "Dependencies and generated files may change, and the PM2 process may restart.",
        confirmText: "Deploy application",
      },
    });
  }

  if (type === "static" && raw.hasPackageJson) {
    return finish({
      id: "static-build",
      label: "Build static website",
      description:
        "Install locked dependencies and create the declared production build.",
      risk: "disruptive",
      scope: "site-user",
      steps: [
        {
          command: "node-install",
          label: `Install with ${raw.packageManager?.label || "package manager"}`,
          description: "Synchronize locked dependencies.",
        },
        {
          command: "node-run:build",
          label: "Build static assets",
          description: "Run the declared production build.",
        },
      ],
      warnings: [
        "Confirm CloudPanel serves the framework's configured output directory before switching traffic.",
      ],
      confirmation: {
        title: "Build the static website?",
        message:
          "Generated assets may be replaced. Panelavo will not guess or switch the document root.",
        confirmText: "Run static build",
      },
    });
  }

  if (
    type === "php" &&
    (raw.hasComposer || raw.hasBuildScript || raw.hasArtisan)
  ) {
    const steps = [
      ...(raw.hasPackageJson
        ? [
            {
              command: "node-install",
              label: `Install frontend dependencies`,
              description: "Synchronize locked frontend dependencies.",
            },
            ...(raw.hasBuildScript
              ? [
                  {
                    command: "node-run:build",
                    label: "Build frontend assets",
                    description: "Run the declared asset build.",
                  },
                ]
              : []),
          ]
        : []),
      ...(raw.hasComposer
        ? [
            {
              command: "composer-install-production",
              label: "Install PHP dependencies",
              description:
                "Synchronize vendor/ to composer.lock without development packages.",
            },
          ]
        : []),
      ...(raw.hasArtisan
        ? [
            {
              command: "artisan-optimize",
              label: "Build Laravel caches",
              description: "Cache production framework metadata.",
            },
          ]
        : []),
    ];
    return finish({
      id: "php",
      label: raw.hasArtisan
        ? "Build and deploy Laravel application"
        : "Build and deploy PHP application",
      description:
        "Install locked dependencies and prepare production caches without applying database migrations.",
      risk: "disruptive",
      scope: "site-user",
      steps,
      warnings: raw.hasArtisan
        ? [
            "Database migrations are intentionally separate and require an explicit backup-aware confirmation.",
          ]
        : [],
      confirmation: {
        title: "Deploy the PHP application?",
        message:
          "Dependencies, generated assets, and application caches may change. Database migrations are not included.",
        confirmText: "Deploy application",
      },
    });
  }

  if (
    type === "python" &&
    (raw.hasRequirements || raw.hasPyproject || raw.hasPipfile)
  ) {
    const needsVenv = raw.pythonManager?.id === "pip" && !raw.hasPythonVenv;
    return finish({
      id: "python",
      label: "Prepare Python application",
      description:
        "Create or synchronize the isolated environment and run Django deployment checks when available.",
      risk: "disruptive",
      scope: "site-user",
      steps: [
        ...(needsVenv
          ? [
              {
                command: "python-create-venv",
                label: "Create virtual environment",
                description: "Create the site-owned .venv.",
              },
            ]
          : []),
        {
          command: "python-install",
          label: `Sync with ${raw.pythonManager?.label || "Python"}`,
          description: "Install the selected dependency definition.",
        },
        ...(raw.hasManagePy
          ? [
              {
                command: "django-check-deploy",
                label: "Run Django deployment checks",
                description: "Validate production security and configuration.",
              },
            ]
          : []),
        ...(raw.hasEcosystem
          ? [
              {
                command: "pm2-start",
                label: "Start or reload process",
                description: "Apply the explicit PM2 ecosystem declaration.",
              },
              {
                command: "pm2-save",
                label: "Persist process state",
                description: "Save the site-user PM2 process list.",
              },
              ...(raw.expectedPort
                ? [
                    {
                      command: "runtime-port-verify",
                      label: "Verify application port",
                      description:
                        "Confirm the app accepts traffic on CloudPanel's configured port.",
                    },
                  ]
                : []),
            ]
          : []),
      ],
      warnings: raw.hasEcosystem
        ? []
        : [
            "No explicit process-manager declaration was found; dependency preparation does not infer or start a WSGI/ASGI server.",
          ],
      confirmation: {
        title: "Prepare the Python application?",
        message:
          "The isolated dependency environment may change. Database migrations are not included.",
        confirmText: "Prepare application",
      },
    });
  }
  return undefined;
}

export function normalizeOperationsData(
  raw: RawOperationsData,
  options: NormalizeOptions = {},
): OperationsData {
  const type = options.typeOverride ?? raw.type ?? "generic";
  const permissions = {
    manage: Boolean(raw.permissions?.manage || options.panelAdmin),
    docker: Boolean(raw.permissions?.docker),
  };
  const normalizedRaw = { ...raw, type, permissions };
  const architecture = detections(normalizedRaw, type);
  const checks = preflightChecks(normalizedRaw, type);
  const blocked = checks.some((item) => item.blocker);
  const warned = checks.some((item) => item.status === "warning");
  return {
    ...normalizedRaw,
    schemaVersion: 1,
    type,
    path: raw.path ?? "",
    architecture,
    preflight: {
      status: !permissions.manage
        ? "unauthorized"
        : blocked
          ? "blocked"
          : warned
            ? "warning"
            : "ready",
      checkedAt: raw.checkedAt ?? new Date().toISOString(),
      checks,
    },
    plan: planFor(normalizedRaw, type, checks),
    groups: actionGroups(normalizedRaw, type),
  };
}
