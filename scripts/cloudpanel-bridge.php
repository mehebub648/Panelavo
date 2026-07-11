<?php

declare(strict_types=1);

// Read-only bridge for functionality that CloudPanel's public clpctl does not
// expose (password verification and authorized site reads). It is invoked as a
// root CLI process by the Next.js server; it never handles an HTTP request.

use App\Entity\Site;
use App\Entity\User;
use App\Entity\BlockedIp;
use App\Entity\BlockedBot;
use App\Entity\BasicAuth;
use App\Entity\SshUser;
use App\Entity\FtpUser;
use App\Entity\CronJob;
use App\Kernel;
use App\Security\Authenticator\MfaAuthenticator;
use App\Site\NodejsSite as NodejsSiteModel;
use App\Site\PhpSite as PhpSiteModel;
use App\Site\PythonSite as PythonSiteModel;
use App\Site\ReverseProxySite as ReverseProxySiteModel;
use App\Site\StaticSite as StaticSiteModel;
use App\Site\Updater\NodejsSite as NodejsSiteUpdater;
use App\Site\Updater\PhpSite as PhpSiteUpdater;
use App\Site\Updater\PythonSite as PythonSiteUpdater;
use App\Site\Updater\ReverseProxySite as ReverseProxySiteUpdater;
use App\Site\Updater\StaticSite as StaticSiteUpdater;
use Symfony\Component\Dotenv\Dotenv;

const CLOUDPANEL_ROOT = '/home/clp/htdocs/app/files';

require CLOUDPANEL_ROOT . '/vendor/autoload.php';
(new Dotenv())->bootEnv(CLOUDPANEL_ROOT . '/.env');

function respond(array $value, int $status = 0): never
{
    echo json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), PHP_EOL;
    exit($status);
}

function publicUser(User $user): array
{
    $role = match ($user->getRole()) {
        User::ROLE_ADMIN => 'admin',
        User::ROLE_SITE_MANAGER => 'site-manager',
        User::ROLE_USER => 'user',
        default => 'unknown',
    };
    return [
        'id' => (string) $user->getId(),
        'username' => $user->getUserName(),
        'displayName' => trim($user->getFirstName() . ' ' . $user->getLastName()),
        'firstName' => $user->getFirstName(),
        'lastName' => $user->getLastName(),
        'role' => $role,
        'canCreateSites' => in_array($role, ['admin', 'site-manager'], true),
        'email' => $user->getEmail(),
        // Timezone is a Doctrine relation, not a string.
        'timezone' => method_exists($user, 'getTimezone') ? $user->getTimezone()?->getName() : null,
        'status' => (bool) $user->getStatus(),
        'sites' => array_map(fn($site) => $site->getDomainName(), $user->getSites()->toArray()),
        'mfa' => (bool) $user->hasMfaEnabled(),
    ];
}

function publicSite(Site $site): array
{
    $runtime = match ($site->getType()) {
        Site::TYPE_PHP => $site->getPhpSettings()?->getPhpVersion(),
        Site::TYPE_NODEJS => $site->getNodejsSettings()?->getNodejsVersion(),
        Site::TYPE_PYTHON => $site->getPythonSettings()?->getPythonVersion(),
        default => null,
    };
    return [
        'id' => (string) $site->getId(),
        'domain' => $site->getDomainName(),
        'type' => $site->getType(),
        'runtimeVersion' => $runtime,
        'siteUser' => $site->getUser(),
        'application' => $site->getApplication(),
        'rootDirectory' => $site->getRootDirectory(),
        'appPort' => $site->getNodejsSettings()?->getPort() ?? $site->getPythonSettings()?->getPort(),
        'reverseProxyUrl' => $site->getReverseProxyUrl(),
        'status' => 'active',
        'createdAt' => $site->getCreatedAt()?->format(DATE_ATOM),
        'url' => 'https://' . $site->getDomainName(),
    ];
}

function authorizedSite($manager, User $user, string $domain): Site
{
    $site = $manager->getRepository(Site::class)->findOneBy(['domainName' => $domain]);
    $allowed = $site instanceof Site && (
        in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true)
        || $user->hasSite($site)
    );
    if (!$allowed) {
        respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);
    }
    return $site;
}

function siteModel(Site $site): array
{
    [$model, $updater] = match ($site->getType()) {
        Site::TYPE_NODEJS => [new NodejsSiteModel(), NodejsSiteUpdater::class],
        Site::TYPE_PHP => [new PhpSiteModel(), PhpSiteUpdater::class],
        Site::TYPE_PYTHON => [new PythonSiteModel(), PythonSiteUpdater::class],
        Site::TYPE_REVERSE_PROXY => [new ReverseProxySiteModel(), ReverseProxySiteUpdater::class],
        default => [new StaticSiteModel(), StaticSiteUpdater::class],
    };
    $model->setDomainName($site->getDomainName());
    $model->setUser($site->getUser());
    $model->setRootDirectory($site->getRootDirectory());
    $model->setVhostTemplate($site->getVhostTemplate());
    $model->setAllowTrafficFromCloudflareOnly($site->allowTrafficFromCloudflareOnly());
    $model->setPageSpeedEnabled($site->getPageSpeedEnabled());
    $model->setPageSpeedSettings($site->getPageSpeedSettings());
    $model->setBlockedIps($site->getBlockedIps());
    $model->setBlockedBots($site->getBlockedBots());
    $model->setBasicAuth($site->getBasicAuth());
    $model->setSshUsers($site->getSshUsers());
    $model->setFtpUsers($site->getFtpUsers());
    $model->setCronJobs($site->getCronJobs());
    $model->setSshKeys($site->getSshKeys());
    if ($model instanceof NodejsSiteModel) $model->setNodejsSettings($site->getNodejsSettings());
    if ($model instanceof PhpSiteModel) {
        $model->setPhpSettings($site->getPhpSettings());
        $model->setVarnishCache($site->getVarnishCache());
    }
    if ($model instanceof PythonSiteModel) $model->setPythonSettings($site->getPythonSettings());
    if ($model instanceof ReverseProxySiteModel) $model->setReverseProxyUrl($site->getReverseProxyUrl());
    return [$model, new $updater($model)];
}

function fileManagerBase(Site $site): string
{
    $base = realpath('/home/' . $site->getUser());
    if (!$base || !is_dir($base)) respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);
    return $base;
}

function safeFileManagerPath(string $base, string $relative, bool $mustExist = true): string
{
    $relative = trim(str_replace('\\', '/', $relative), '/');
    if ($relative === '') return $base;
    foreach (explode('/', $relative) as $part) {
        if ($part === '' || $part === '.' || $part === '..') respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    }
    $path = $base . '/' . $relative;
    if ($mustExist) {
        $real = realpath($path);
        if (!$real || ($real !== $base && !str_starts_with($real, $base . '/'))) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
        return $real;
    }
    $parent = realpath(dirname($path));
    if (!$parent || ($parent !== $base && !str_starts_with($parent, $base . '/'))) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    return $path;
}

function fileManagerListing(Site $site, ?string $relative = null): array
{
    $base = fileManagerBase($site);
    $relative ??= 'htdocs/' . trim($site->getRootDirectory(), '/');
    $directory = safeFileManagerPath($base, $relative);
    if (!is_dir($directory)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    $items = [];
    foreach (scandir($directory) ?: [] as $name) {
        if ($name === '.' || $name === '..') continue;
        $path = $directory . '/' . $name;
        $items[] = [
            'name' => $name,
            'type' => is_dir($path) ? 'directory' : 'file',
            'size' => is_file($path) ? (filesize($path) ?: 0) : 0,
            'modified' => gmdate(DATE_ATOM, filemtime($path) ?: time()),
            'permissions' => substr(sprintf('%o', fileperms($path)), -4),
        ];
    }
    usort($items, fn($a, $b) => $a['type'] === $b['type'] ? strcasecmp($a['name'], $b['name']) : ($a['type'] === 'directory' ? -1 : 1));
    return ['path' => $base, 'relativePath' => trim($relative, '/'), 'items' => $items];
}

function deleteTree(string $path): void
{
    if (is_link($path) || is_file($path)) { unlink($path); return; }
    foreach (scandir($path) ?: [] as $name) if ($name !== '.' && $name !== '..') deleteTree($path . '/' . $name);
    rmdir($path);
}

function copyTree(string $source, string $destination): void
{
    if (is_link($source) || is_file($source)) { if (!copy($source, $destination)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']); return; }
    if (!mkdir($destination, fileperms($source) & 0777)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    foreach (scandir($source) ?: [] as $name) if ($name !== '.' && $name !== '..') copyTree($source . '/' . $name, $destination . '/' . $name);
}



function siteKeyPair(Site $site): array
{
    $key = '/home/' . $site->getUser() . '/.ssh/id_ed25519';
    $public = is_file($key . '.pub') ? trim((string) file_get_contents($key . '.pub')) : '';
    $privatePreview = '';
    if (is_file($key)) {
        $lines = preg_split('/\R/', trim((string) file_get_contents($key))) ?: [];
        $privatePreview = implode("\n", array_merge(array_slice($lines, 0, 2), ['••••••••••••••••••••••••'], array_slice($lines, -2)));
    }
    return [
        'exists' => is_file($key) && $public !== '',
        'publicKey' => $public,
        'privateKeyMasked' => $privatePreview,
        'fingerprint' => $public !== '' ? trim((string) shell_exec('/usr/bin/ssh-keygen -lf ' . escapeshellarg($key . '.pub') . ' 2>/dev/null')) : '',
    ];
}

function siteRootPath(Site $site): string
{
    $user = (string) $site->getUser();
    if (!preg_match('/^[A-Za-z0-9._-]{1,64}$/', $user)) {
        respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);
    }
    $base = realpath('/home/' . $user . '/htdocs');
    if (!$base || !is_dir($base)) respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);

    $relative = trim(str_replace('\\', '/', (string) $site->getRootDirectory()), '/');
    if (str_contains($relative, "\0")) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    if ($relative !== '') {
        foreach (explode('/', $relative) as $part) {
            if ($part === '' || $part === '.' || $part === '..') {
                respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
            }
        }
    }

    $candidate = $base . ($relative === '' ? '' : '/' . $relative);
    if (!pathIsContained($candidate, $base)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    return realpath($candidate) ?: $candidate;
}

function normalizeAbsolutePath(string $path): ?string
{
    if ($path === '' || $path[0] !== '/' || str_contains($path, "\0")) return null;
    $parts = [];
    foreach (explode('/', str_replace('\\', '/', $path)) as $part) {
        if ($part === '' || $part === '.') continue;
        if ($part === '..') {
            if (!$parts) return null;
            array_pop($parts);
            continue;
        }
        $parts[] = $part;
    }
    return '/' . implode('/', $parts);
}

// Lexical containment is not enough: every existing ancestor is resolved so
// a symlink inside htdocs cannot redirect operations to another site or host
// path. Non-existent leaf paths are accepted only when their nearest existing
// ancestor is still inside the allowed root.
function pathIsContained(string $candidate, string $root): bool
{
    $root = realpath($root) ?: normalizeAbsolutePath($root);
    $candidate = normalizeAbsolutePath($candidate);
    if (!$root || !$candidate || ($candidate !== $root && !str_starts_with($candidate, $root . '/'))) return false;

    $probe = $candidate;
    while (!file_exists($probe) && !is_link($probe)) {
        $parent = dirname($probe);
        if ($parent === $probe) return false;
        $probe = $parent;
    }
    $resolved = realpath($probe);
    return $resolved !== false && ($resolved === $root || str_starts_with($resolved, $root . '/'));
}

// Rewrites a vhost template so every server block serves the given alias
// domains next to the original server_name, optionally blocking the system
// domain itself (error or redirect to a customer domain). All injections are
// marker-tagged, so re-running with a new configuration is idempotent:
//   server_name {{orig}} alias1 alias2; #panel:orig={{orig}}
//   #panel:block:start ... #panel:block:end
// ACME challenge requests stay reachable while blocking, so certificates for
// the system domain keep renewing.
function applyDomainConfig(string $template, array $aliases, string $block, string $systemDomain, string $redirectTo): string
{
    $stripped = [];
    $skipping = false;
    foreach (preg_split('/\R/', $template) as $line) {
        if (str_contains($line, '#panel:block:start')) { $skipping = true; continue; }
        if (str_contains($line, '#panel:block:end')) { $skipping = false; continue; }
        if ($skipping) continue;
        if (preg_match('/^(\s*)server_name\s+[^;]*;\s*#panel:orig=(.*)$/', $line, $m)) {
            $line = $m[1] . 'server_name ' . trim($m[2]) . ';';
        }
        $stripped[] = $line;
    }
    $result = [];
    foreach ($stripped as $line) {
        if (!preg_match('/^(\s*)server_name\s+([^;]+);\s*$/', $line, $m)) {
            $result[] = $line;
            continue;
        }
        $indent = $m[1];
        $orig = trim($m[2]);
        $result[] = $aliases
            ? $indent . 'server_name ' . $orig . ' ' . implode(' ', $aliases) . '; #panel:orig=' . $orig
            : $line;
        if ($block !== 'none') {
            $action = $block === 'redirect' && $redirectTo !== ''
                ? 'return 301 https://' . $redirectTo . '$request_uri;'
                : 'return 403;';
            $result[] = $indent . '#panel:block:start';
            $result[] = $indent . 'set $panel_block "";';
            $result[] = $indent . 'if ($host = "' . $systemDomain . '") { set $panel_block "1"; }';
            $result[] = $indent . 'if ($request_uri ~ "^/\.well-known/acme-challenge/") { set $panel_block ""; }';
            $result[] = $indent . 'if ($panel_block = "1") { ' . $action . ' }';
            $result[] = $indent . '#panel:block:end';
        }
    }
    return implode("\n", $result);
}

// Latest nvm-managed Node.js bin directory under a home, if any. CloudPanel
// installs Node.js per site user through nvm, so node/npm are not on the
// system PATH.
function nodeBinPath(string $home): string
{
    $candidates = glob($home . '/.nvm/versions/node/*/bin') ?: [];
    usort($candidates, 'strnatcmp');
    return $candidates ? (string) end($candidates) : '';
}

// Directories searched for site-user tools, in the same order as the PATH
// runSiteCommand builds, so availability reported by the preflight always
// matches what an execution would actually resolve.
function sitePathDirs(string $home, bool $asRoot = false): array
{
    if ($asRoot) return ['/usr/local/bin', '/usr/bin', '/bin'];
    return array_values(array_filter([
        nodeBinPath($home),
        $home . '/.local/bin',
        $home . '/.bun/bin',
        $home . '/.config/composer/vendor/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
    ]));
}

function findSiteTool(string $home, string $binary, bool $asRoot = false): ?string
{
    foreach (sitePathDirs($home, $asRoot) as $dir) {
        if (is_executable($dir . '/' . $binary)) return $dir . '/' . $binary;
    }
    return null;
}

// Runs an allow-listed maintenance command inside the site root as the site
// user, through env(1) so PATH/HOME survive sudo's environment reset.
function runSiteCommand(Site $site, array $args, int $timeout = 300, bool $asRoot = false): array
{
    $cwd = realpath(siteRootPath($site));
    if (!$cwd) respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);
    $timeout = max(1, min($timeout, 900));
    $home = $asRoot ? '/root' : '/home/' . $site->getUser();
    $runUser = $asRoot ? 'root' : (string) $site->getUser();
    // Start from an empty environment. In particular, a site-owned Compose
    // file must never interpolate CloudPanel or Panelavo process secrets.
    // Dependency managers are pinned to project-local environments so nothing
    // they create ever lands outside the site root.
    $env = [
        '/usr/bin/env', '-i',
        'PATH=' . implode(':', sitePathDirs($home, $asRoot)),
        'HOME=' . $home,
        'USER=' . $runUser,
        'LOGNAME=' . $runUser,
        'LANG=C.UTF-8',
        'CI=1',
        'COMPOSER_NO_INTERACTION=1',
        'DEBIAN_FRONTEND=noninteractive',
        'PIP_DISABLE_PIP_VERSION_CHECK=1',
        'POETRY_VIRTUALENVS_IN_PROJECT=1',
        'PIPENV_VENV_IN_PROJECT=1',
    ];
    $command = array_merge(
        ['/usr/bin/timeout', '--signal=KILL', $timeout . 's'],
        $asRoot ? $env : array_merge(['/usr/bin/sudo', '-n', '-u', $site->getUser(), '--'], $env),
        $args,
    );
    $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd);
    if (!is_resource($process)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $stdout = '';
    $stderr = '';
    $stdoutTruncated = false;
    $stderrTruncated = false;
    $deadline = microtime(true) + $timeout + 5;
    $lastStatus = null;
    $append = static function (string &$target, string $chunk, int $limit, bool &$truncated): void {
        $remaining = $limit - strlen($target);
        if ($remaining > 0) $target .= substr($chunk, 0, $remaining);
        if (strlen($chunk) > max(0, $remaining)) $truncated = true;
    };

    while (true) {
        $read = [];
        if (!feof($pipes[1])) $read[] = $pipes[1];
        if (!feof($pipes[2])) $read[] = $pipes[2];
        if ($read) {
            $write = null;
            $except = null;
            @stream_select($read, $write, $except, 0, 200000);
            foreach ($read as $stream) {
                $chunk = (string) fread($stream, 8192);
                if ($chunk === '') continue;
                if ($stream === $pipes[1]) $append($stdout, $chunk, 400000, $stdoutTruncated);
                else $append($stderr, $chunk, 100000, $stderrTruncated);
            }
        } else {
            usleep(10000);
        }

        $lastStatus = proc_get_status($process);
        if (!$lastStatus['running']) {
            foreach ([1, 2] as $index) {
                while (!feof($pipes[$index])) {
                    $chunk = (string) fread($pipes[$index], 8192);
                    if ($chunk === '') break;
                    if ($index === 1) $append($stdout, $chunk, 400000, $stdoutTruncated);
                    else $append($stderr, $chunk, 100000, $stderrTruncated);
                }
            }
            break;
        }
        if (microtime(true) >= $deadline) {
            proc_terminate($process, 9);
            $lastStatus = ['exitcode' => 137, 'running' => false];
            break;
        }
    }

    fclose($pipes[1]);
    fclose($pipes[2]);
    $closedCode = proc_close($process);
    $code = $closedCode >= 0 ? $closedCode : (int) ($lastStatus['exitcode'] ?? 1);
    if ($stdoutTruncated) $stdout .= "\n[stdout truncated by Panelavo]";
    if ($stderrTruncated) $stderr .= "\n[stderr truncated by Panelavo]";
    return [
        'code' => $code,
        'timedOut' => $code === 137,
        'stdout' => $stdout,
        'stderr' => $stderr,
    ];
}

function detectFramework(string $root, ?array $package = null): string
{
    $package ??= is_file($root . '/package.json') ? json_decode((string) file_get_contents($root . '/package.json'), true) : null;
    $deps = is_array($package) ? array_merge($package['dependencies'] ?? [], $package['devDependencies'] ?? []) : [];
    foreach ([
        'next' => 'Next.js', 'nuxt' => 'Nuxt', '@remix-run/node' => 'Remix', 'astro' => 'Astro',
        '@sveltejs/kit' => 'SvelteKit', 'gatsby' => 'Gatsby', '@angular/core' => 'Angular',
        '@adonisjs/core' => 'AdonisJS', '@strapi/strapi' => 'Strapi', '@nestjs/core' => 'NestJS',
        'react-scripts' => 'Create React App', 'vite' => 'Vite', 'express' => 'Express',
        'fastify' => 'Fastify', 'koa' => 'Koa', 'hono' => 'Hono',
    ] as $dep => $label) {
        if (isset($deps[$dep])) return $label;
    }
    $composer = is_file($root . '/composer.json') ? json_decode((string) file_get_contents($root . '/composer.json'), true) : null;
    $phpDeps = is_array($composer) ? ($composer['require'] ?? []) : [];
    if (isset($phpDeps['laravel/framework'])) return 'Laravel';
    if (isset($phpDeps['symfony/framework-bundle'])) return 'Symfony';
    if (is_file($root . '/wp-config.php') || is_file($root . '/wp-load.php')) return 'WordPress';
    if (is_file($root . '/artisan')) return 'Laravel';
    if (is_file($root . '/bin/console')) return 'Symfony';
    if (is_file($root . '/craft')) return 'Craft CMS';
    if (is_file($root . '/manage.py')) return 'Django';
    $pythonManifest = '';
    foreach (['pyproject.toml', 'requirements.txt', 'Pipfile'] as $manifest) {
        if (is_file($root . '/' . $manifest)) $pythonManifest .= (string) @file_get_contents($root . '/' . $manifest, false, null, 0, 65536);
    }
    if ($pythonManifest !== '') {
        foreach (['fastapi' => 'FastAPI', 'flask' => 'Flask', 'django' => 'Django'] as $needle => $label) {
            if (preg_match('/^\s*(?:"|\')?' . $needle . '\b/im', $pythonManifest)) return $label;
        }
    }
    foreach (['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'] as $file) {
        if (is_file($root . '/' . $file)) return 'Docker Compose';
    }
    return '';
}

// Picks the one Node package manager the project unambiguously declares:
// package.json "packageManager" wins, otherwise a single lockfile decides,
// otherwise npm is the safe default. Two disagreeing lockfiles are reported
// as ambiguous instead of guessing. "detail" carries the exact install
// command so the UI previews exactly what would run.
function detectNodeManager(string $root, ?array $package, string $home): array
{
    $locks = [];
    if (is_file($root . '/package-lock.json')) $locks['npm'] = 'package-lock.json';
    if (is_file($root . '/pnpm-lock.yaml')) $locks['pnpm'] = 'pnpm-lock.yaml';
    if (is_file($root . '/yarn.lock')) $locks['yarn'] = 'yarn.lock';
    if (is_file($root . '/bun.lock')) $locks['bun'] = 'bun.lock';
    elseif (is_file($root . '/bun.lockb')) $locks['bun'] = 'bun.lockb';

    $declared = null;
    $field = $package['packageManager'] ?? null;
    if (is_string($field) && preg_match('/^(npm|pnpm|yarn|bun)@/', $field, $match)) $declared = $match[1];

    $id = $declared ?? (count($locks) === 1 ? array_key_first($locks) : (count($locks) === 0 ? 'npm' : null));
    if ($id === null) {
        return [
            'id' => 'unknown',
            'label' => 'Package manager',
            'available' => false,
            'ambiguous' => true,
            'detail' => 'Multiple lockfiles were found (' . implode(', ', $locks)
                . '). Keep exactly one lockfile or declare "packageManager" in package.json.',
        ];
    }
    $labels = ['npm' => 'npm', 'pnpm' => 'pnpm', 'yarn' => 'Yarn', 'bun' => 'Bun'];
    $lockfile = $locks[$id] ?? null;
    $command = match ($id) {
        'npm' => $lockfile ? 'npm ci' : 'npm install',
        'pnpm' => $lockfile ? 'pnpm install --frozen-lockfile' : 'pnpm install',
        'yarn' => is_file($root . '/.yarnrc.yml') ? 'yarn install --immutable'
            : ($lockfile ? 'yarn install --frozen-lockfile' : 'yarn install'),
        'bun' => $lockfile ? 'bun install --frozen-lockfile' : 'bun install',
    };
    return array_filter([
        'id' => $id,
        'label' => $labels[$id],
        'available' => findSiteTool($home, $id) !== null,
        'lockfile' => $lockfile,
        'detail' => $command,
    ], static fn($value) => $value !== null);
}

// Same idea for Python: an explicit lockfile (uv.lock, poetry.lock,
// Pipfile.lock) selects the tool; without one the manifest decides, and pip
// with requirements.txt into a project-owned .venv is the fallback.
function detectPythonManager(string $root, string $home): ?array
{
    $locks = [];
    if (is_file($root . '/uv.lock')) $locks['uv'] = 'uv.lock';
    if (is_file($root . '/poetry.lock')) $locks['poetry'] = 'poetry.lock';
    if (is_file($root . '/Pipfile.lock')) $locks['pipenv'] = 'Pipfile.lock';
    if (count($locks) > 1) {
        return [
            'id' => 'unknown',
            'label' => 'Python dependency manager',
            'available' => false,
            'ambiguous' => true,
            'detail' => 'Multiple Python lockfiles were found (' . implode(', ', $locks)
                . '). Keep the lockfile of one tool only.',
        ];
    }
    $pyproject = is_file($root . '/pyproject.toml') ? (string) @file_get_contents($root . '/pyproject.toml', false, null, 0, 65536) : '';
    $id = count($locks) === 1 ? array_key_first($locks) : null;
    if ($id === null && $pyproject !== '' && str_contains($pyproject, '[tool.poetry]')) $id = 'poetry';
    if ($id === null && is_file($root . '/Pipfile')) $id = 'pipenv';
    if ($id === null && is_file($root . '/requirements.txt')) $id = 'pip';
    if ($id === null && $pyproject !== '') $id = 'uv';
    if ($id === null) return null;
    $labels = ['uv' => 'uv', 'poetry' => 'Poetry', 'pipenv' => 'Pipenv', 'pip' => 'pip'];
    $command = match ($id) {
        'uv' => isset($locks['uv']) ? 'uv sync --frozen' : 'uv sync',
        'poetry' => 'poetry install --only main --no-interaction',
        'pipenv' => isset($locks['pipenv']) ? 'pipenv sync' : 'pipenv install',
        'pip' => '.venv/bin/python -m pip install -r requirements.txt',
    };
    $binary = $id === 'pip' ? 'python3' : $id;
    return array_filter([
        'id' => $id,
        'label' => $labels[$id],
        'available' => findSiteTool($home, $binary) !== null,
        'lockfile' => $locks[$id] ?? null,
        'detail' => $command,
    ], static fn($value) => $value !== null);
}

// Stable, deterministic Compose project name per site so root Compose
// commands always address exactly this site's containers.
function composeProjectName(Site $site): string
{
    $name = trim(strtolower((string) preg_replace('/[^a-z0-9]+/i', '-', $site->getDomainName())), '-');
    return 'panelavo-' . ($name !== '' ? $name : 'site');
}

// Host-safety policy for rootful Compose: everything the project touches must
// stay inside the site root, published ports must bind to loopback only, and
// no privilege- or namespace-escalating feature is accepted. First violation
// wins; warnings are advisory only.
function composeSafetyScan(array $config, string $root): array
{
    $warnings = [];
    $inRoot = static function ($path) use ($root): bool {
        return is_string($path) && $path !== '' && pathIsContained($path, $root);
    };
    $fail = static fn(string $detail) => ['safe' => false, 'detail' => $detail, 'warnings' => []];
    foreach (($config['services'] ?? []) as $name => $service) {
        if (!is_array($service)) continue;
        if (!empty($service['privileged'])) return $fail("Service \"$name\" requests privileged mode.");
        if (!empty($service['cap_add'])) return $fail("Service \"$name\" adds Linux capabilities.");
        if (!empty($service['devices'])) return $fail("Service \"$name\" maps host devices.");
        if (!empty($service['sysctls'])) return $fail("Service \"$name\" sets host sysctls.");
        foreach (['network_mode', 'pid', 'ipc', 'userns_mode', 'cgroup'] as $key) {
            $value = $service[$key] ?? null;
            if (is_string($value) && ($value === 'host' || str_starts_with($value, 'container:') || str_starts_with($value, 'service:'))) {
                return $fail("Service \"$name\" shares the host or another container's $key namespace.");
            }
        }
        foreach ((array) ($service['security_opt'] ?? []) as $option) {
            if (!is_string($option) || !str_starts_with($option, 'no-new-privileges')) {
                return $fail("Service \"$name\" sets a security option Panelavo will not run as root.");
            }
        }
        foreach ((array) ($service['ports'] ?? []) as $port) {
            $hostIp = is_array($port) ? (string) ($port['host_ip'] ?? '') : '';
            $published = is_array($port) ? ($port['published'] ?? null) : $port;
            if ($published === null || $published === '') continue;
            if (!in_array($hostIp, ['127.0.0.1', '::1', 'localhost'], true)) {
                return $fail("Service \"$name\" publishes a port without binding it to 127.0.0.1.");
            }
        }
        foreach ((array) ($service['volumes'] ?? []) as $volume) {
            if (is_array($volume) && ($volume['type'] ?? '') === 'bind' && !$inRoot($volume['source'] ?? '')) {
                return $fail("Service \"$name\" bind-mounts a path outside the website root.");
            }
        }
        $build = $service['build'] ?? null;
        $context = is_array($build) ? ($build['context'] ?? '') : (is_string($build) ? $build : null);
        if ($context !== null && $context !== '' && !$inRoot($context)) {
            return $fail("Service \"$name\" builds from a context outside the website root.");
        }
        if (empty($service['restart'])) {
            $warnings[] = "Service \"$name\" declares no restart policy; it will not come back after a host reboot.";
        }
    }
    foreach (['secrets', 'configs'] as $section) {
        foreach ((array) ($config[$section] ?? []) as $name => $entry) {
            if (is_array($entry) && isset($entry['file']) && !$inRoot($entry['file'])) {
                return $fail(ucfirst($section) . " entry \"$name\" reads a file outside the website root.");
            }
        }
    }
    return ['safe' => true, 'detail' => null, 'warnings' => $warnings];
}

// Full Compose readiness probe: CLI, v2 plugin, daemon, resolved
// configuration, and host-safety policy — each reported separately so the
// preflight can show exactly which layer is missing.
function composeCapability(Site $site, string $root, ?string $file): array
{
    $cli = null;
    foreach (['/usr/bin/docker', '/usr/local/bin/docker'] as $candidate) {
        if (is_executable($candidate)) { $cli = $candidate; break; }
    }
    $capability = [
        'file' => $file,
        'cliAvailable' => $cli !== null,
        'pluginAvailable' => false,
        'daemonAvailable' => false,
        'warnings' => [],
    ];
    if (!$file || !$cli) return $capability;
    $version = runSiteCommand($site, ['docker', 'compose', 'version', '--short'], 15, true);
    if ($version['code'] !== 0) return $capability;
    $capability['pluginAvailable'] = true;
    $capability['version'] = trim($version['stdout']);
    $info = runSiteCommand($site, ['docker', 'info', '--format', '{{.ServerVersion}}'], 15, true);
    $capability['daemonAvailable'] = $info['code'] === 0;
    $config = runSiteCommand($site, ['docker', 'compose', '-f', $file, '-p', composeProjectName($site), 'config', '--format', 'json'], 60, true);
    if ($config['code'] !== 0) {
        $capability['configValid'] = false;
        $detail = trim($config['stderr'] !== '' ? $config['stderr'] : $config['stdout']);
        $capability['detail'] = $detail !== '' ? substr($detail, 0, 500) : 'The Compose configuration could not be validated.';
        return $capability;
    }
    $parsed = json_decode($config['stdout'], true);
    if (!is_array($parsed)) {
        $capability['configValid'] = false;
        $capability['detail'] = 'The resolved Compose configuration could not be parsed for the host-safety review.';
        return $capability;
    }
    $capability['configValid'] = true;
    $capability['services'] = array_map('strval', array_keys($parsed['services'] ?? []));
    $safety = composeSafetyScan($parsed, $root);
    $capability['safe'] = $safety['safe'];
    if (!$safety['safe']) $capability['detail'] = $safety['detail'];
    $capability['warnings'] = $safety['warnings'];
    return $capability;
}

// One server-owned snapshot of everything Operations needs: manifests,
// lockfiles, runtimes, managers, and the Compose capability. The same
// snapshot backs the preflight response and every execution precondition, so
// what the UI shows and what the server enforces can never drift apart.
function operationsState(Site $site, User $user): array
{
    $root = siteRootPath($site);
    $home = '/home/' . $site->getUser();
    $package = is_file($root . '/package.json') ? json_decode((string) file_get_contents($root . '/package.json'), true) : null;
    $package = is_array($package) ? $package : null;
    $scripts = [];
    foreach (($package['scripts'] ?? []) as $name => $command) {
        if (is_string($command)) $scripts[] = ['name' => (string) $name, 'command' => $command];
    }
    $composeFile = null;
    foreach (['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'] as $candidate) {
        if (is_file($root . '/' . $candidate)) { $composeFile = $candidate; break; }
    }
    $ecosystem = null;
    foreach (['ecosystem.config.js', 'ecosystem.config.cjs', 'ecosystem.config.json'] as $candidate) {
        if (is_file($root . '/' . $candidate)) { $ecosystem = $candidate; break; }
    }
    $venvPython = null;
    foreach (['.venv/bin/python', 'venv/bin/python'] as $candidate) {
        if (is_file($root . '/' . $candidate)) { $venvPython = $root . '/' . $candidate; break; }
    }
    $tools = [];
    foreach ([
        'node' => ['Node.js', 'node'], 'npm' => ['npm', 'npm'], 'pnpm' => ['pnpm', 'pnpm'],
        'yarn' => ['Yarn', 'yarn'], 'bun' => ['Bun', 'bun'], 'pm2' => ['PM2', 'pm2'],
        'php' => ['PHP', 'php'], 'composer' => ['Composer', 'composer'], 'wp' => ['WP-CLI', 'wp'],
        'python' => ['Python', 'python3'], 'uv' => ['uv', 'uv'], 'poetry' => ['Poetry', 'poetry'],
        'pipenv' => ['Pipenv', 'pipenv'], 'docker' => ['Docker', 'docker'], 'curl' => ['curl', 'curl'],
    ] as $id => [$label, $binary]) {
        $path = findSiteTool($home, $binary);
        $tools[$id] = ['id' => $id, 'label' => $label, 'available' => $path !== null];
    }
    $nodeBin = nodeBinPath($home);
    if ($nodeBin && preg_match('#/node/v?([0-9.]+)/bin$#', $nodeBin, $match)) $tools['node']['version'] = $match[1];
    $pythonManifest = is_file($root . '/requirements.txt') || is_file($root . '/pyproject.toml') || is_file($root . '/Pipfile');
    return [
        'type' => $site->getType(),
        'path' => $root,
        'framework' => detectFramework($root, $package),
        'processName' => preg_replace('/[^a-zA-Z0-9._-]/', '-', $site->getDomainName()),
        'reverseProxyUrl' => $site->getReverseProxyUrl(),
        'checkedAt' => gmdate(DATE_ATOM),
        'hasPackageJson' => $package !== null,
        'hasPackageLock' => is_file($root . '/package-lock.json'),
        'hasBuildScript' => is_string($package['scripts']['build'] ?? null),
        'hasStartScript' => is_string($package['scripts']['start'] ?? null),
        'scripts' => $scripts,
        'hasComposer' => is_file($root . '/composer.json'),
        'hasComposerLock' => is_file($root . '/composer.lock'),
        'hasArtisan' => is_file($root . '/artisan'),
        'hasSymfonyConsole' => is_file($root . '/bin/console'),
        'hasWordPress' => is_file($root . '/wp-config.php') || is_file($root . '/wp-load.php'),
        'hasRequirements' => is_file($root . '/requirements.txt'),
        'hasPyproject' => is_file($root . '/pyproject.toml'),
        'hasPipfile' => is_file($root . '/Pipfile'),
        'hasPythonVenv' => $venvPython !== null,
        'hasManagePy' => is_file($root . '/manage.py'),
        'hasCompose' => $composeFile !== null,
        'hasEcosystem' => $ecosystem !== null,
        'hasIndexHtml' => is_file($root . '/index.html'),
        'hasWorkspace' => isset($package['workspaces']) || is_file($root . '/pnpm-workspace.yaml'),
        'hasEnvFile' => is_file($root . '/.env'),
        'packageManager' => $package !== null ? detectNodeManager($root, $package, $home) : null,
        'pythonManager' => $pythonManifest ? detectPythonManager($root, $home) : null,
        'tools' => $tools,
        'compose' => $composeFile !== null ? composeCapability($site, $root, $composeFile) : null,
        'permissions' => [
            'manage' => in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true),
            'docker' => $user->getRole() === User::ROLE_ADMIN,
        ],
        'ecosystemFile' => $ecosystem,
        'venvPython' => $venvPython,
        'composeProject' => composeProjectName($site),
        'pm2Available' => $tools['pm2']['available'],
        'dockerAvailable' => $tools['docker']['available'],
    ];
}

function actionsSection(Site $site, User $user): array
{
    $state = operationsState($site, $user);
    $processes = [];
    if ($state['pm2Available'] && is_dir($state['path'])) {
        $pm2 = runSiteCommand($site, ['pm2', 'jlist'], 20);
        $start = strpos($pm2['stdout'], '[');
        $list = $start === false ? null : json_decode(substr($pm2['stdout'], $start), true);
        foreach (is_array($list) ? $list : [] as $proc) {
            if (!is_array($proc)) continue;
            $processes[] = [
                'name' => (string) ($proc['name'] ?? ''),
                'status' => (string) ($proc['pm2_env']['status'] ?? 'unknown'),
                'cpu' => (float) ($proc['monit']['cpu'] ?? 0),
                'memory' => (int) ($proc['monit']['memory'] ?? 0),
                'restarts' => (int) ($proc['pm2_env']['restart_time'] ?? 0),
            ];
        }
    }
    unset($state['ecosystemFile'], $state['venvPython'], $state['composeProject']);
    return $state + ['pm2' => $processes];
}

// Maps one validated operation identifier to an exact executable argument
// array with a fixed working directory, bounded timeout, and no shell. Every
// precondition the preflight reports is re-verified here at execution time:
// a stale UI can never run a command whose manifest, tool, or safety check
// has since disappeared.
function resolveOperationStep(array $state, string $command, array $operation): array
{
    $root = $state['path'];
    $tools = $state['tools'];
    $available = static fn(string $id): bool => !empty($tools[$id]['available']);
    $require = static function (bool $ok, string $code = 'ACTION_UNAVAILABLE'): void {
        if (!$ok) respond(['ok' => false, 'code' => $code]);
    };
    $manager = $state['packageManager'];
    $python = $state['pythonManager'];
    $py = $state['venvPython'] ?? 'python3';
    $step = static fn(string $label, array $args, int $timeout = 300, bool $asRoot = false) => [
        'command' => $command,
        'label' => $label,
        'args' => $args,
        'timeout' => $timeout,
        'asRoot' => $asRoot,
    ];

    $nodeManagerArgs = static function (array $verb) use ($state, $manager, $require, $available): array {
        $require($state['hasPackageJson'] && is_array($manager) && empty($manager['ambiguous']));
        $require($available($manager['id']), 'TOOL_UNAVAILABLE');
        return array_merge([$manager['id']], $verb, $manager['id'] === 'npm' ? ['--no-audit', '--no-fund'] : []);
    };
    $composeStep = static function (string $label, array $verb, int $timeout, bool $needsDaemon = true, bool $needsSafety = true) use ($state, $require, $command): array {
        $compose = $state['compose'];
        $require(is_array($compose) && $state['hasCompose']);
        $require($compose['cliAvailable'] && $compose['pluginAvailable'], 'TOOL_UNAVAILABLE');
        if ($needsDaemon) $require($compose['daemonAvailable'], 'TOOL_UNAVAILABLE');
        if ($needsSafety) {
            $require($compose['configValid'] === true);
            if (($compose['safe'] ?? false) !== true) respond(['ok' => false, 'code' => 'UNSAFE_COMPOSE']);
        }
        return [
            'command' => $command,
            'label' => $label,
            'args' => array_merge(['docker', 'compose', '-f', $compose['file'], '-p', $state['composeProject']], $verb),
            'timeout' => $timeout,
            'asRoot' => true,
        ];
    };
    $script = (string) ($operation['script'] ?? '');
    $declaredScripts = array_column($state['scripts'], 'command', 'name');

    switch ($command) {
        case 'node-install':
            $verb = match ($manager['id'] ?? '') {
                'npm' => isset($manager['lockfile']) ? ['ci'] : ['install'],
                'pnpm' => isset($manager['lockfile']) ? ['install', '--frozen-lockfile'] : ['install'],
                'yarn' => is_file($root . '/.yarnrc.yml') ? ['install', '--immutable']
                    : (isset($manager['lockfile']) ? ['install', '--frozen-lockfile'] : ['install']),
                'bun' => isset($manager['lockfile']) ? ['install', '--frozen-lockfile'] : ['install'],
                default => null,
            };
            $require($verb !== null);
            return $step('Install Node.js dependencies', $nodeManagerArgs($verb), 900);
        case 'node-run':
            $require(preg_match('/^[A-Za-z0-9:._-]{1,64}$/', $script) === 1, 'INVALID_REQUEST');
            $require(isset($declaredScripts[$script]));
            return $step('Run script: ' . $script, $nodeManagerArgs(['run', $script]), 900);
        case 'npm-install':
            $require($state['hasPackageJson']);
            $require($available('npm'), 'TOOL_UNAVAILABLE');
            return $step('Install Node.js dependencies', ['npm', 'install', '--no-audit', '--no-fund'], 900);
        case 'npm-ci':
            $require($state['hasPackageJson'] && $state['hasPackageLock']);
            $require($available('npm'), 'TOOL_UNAVAILABLE');
            return $step('Install locked Node.js dependencies', ['npm', 'ci', '--no-audit', '--no-fund'], 900);
        case 'npm-run':
            $require(preg_match('/^[A-Za-z0-9:._-]{1,64}$/', $script) === 1, 'INVALID_REQUEST');
            $require(isset($declaredScripts[$script]));
            $require($available('npm'), 'TOOL_UNAVAILABLE');
            return $step('Run script: ' . $script, ['npm', 'run', $script], 900);
        case 'composer-install':
            $require($state['hasComposer']);
            $require($available('composer'), 'TOOL_UNAVAILABLE');
            return $step('Install PHP dependencies', ['composer', 'install', '--no-interaction', '--no-progress'], 900);
        case 'composer-install-production':
            $require($state['hasComposer'] && $state['hasComposerLock']);
            $require($available('composer'), 'TOOL_UNAVAILABLE');
            return $step('Install PHP dependencies', ['composer', 'install', '--no-dev', '--prefer-dist', '--optimize-autoloader', '--no-interaction', '--no-progress'], 900);
        case 'composer-validate':
            $require($state['hasComposer']);
            $require($available('composer'), 'TOOL_UNAVAILABLE');
            return $step('Validate Composer files', ['composer', 'validate', '--no-check-publish', '--no-interaction'], 120);
        case 'python-create-venv':
            $require($available('python'), 'TOOL_UNAVAILABLE');
            return $step('Create virtual environment', ['python3', '-m', 'venv', '.venv'], 120);
        case 'python-install':
            $require(is_array($python) && empty($python['ambiguous']));
            $require(!empty($python['available']), 'TOOL_UNAVAILABLE');
            [$label, $args] = match ($python['id']) {
                'uv' => ['Sync Python dependencies', isset($python['lockfile']) ? ['uv', 'sync', '--frozen'] : ['uv', 'sync']],
                'poetry' => ['Install Python dependencies', ['poetry', 'install', '--only', 'main', '--no-interaction']],
                'pipenv' => ['Sync Python dependencies', isset($python['lockfile']) ? ['pipenv', 'sync'] : ['pipenv', 'install']],
                'pip' => ['Install Python dependencies', [$py, '-m', 'pip', 'install', '-r', 'requirements.txt']],
                default => [null, null],
            };
            $require($args !== null);
            if ($python['id'] === 'pip') $require($state['hasPythonVenv']);
            return $step($label, $args, 900);
        case 'pip-install':
            $require($state['hasRequirements']);
            $require($available('python'), 'TOOL_UNAVAILABLE');
            return $step('Install Python dependencies', ['python3', '-m', 'pip', 'install', '--user', '-r', 'requirements.txt'], 900);
        case 'artisan-optimize':
        case 'artisan-optimize-clear':
        case 'artisan-migrate-status':
        case 'artisan-migrate':
        case 'artisan-storage-link':
        case 'artisan-queue-restart':
            $require($state['hasArtisan']);
            $require($available('php'), 'TOOL_UNAVAILABLE');
            [$label, $args] = match ($command) {
                'artisan-optimize' => ['Build Laravel caches', ['php', 'artisan', 'optimize']],
                'artisan-optimize-clear' => ['Clear Laravel caches', ['php', 'artisan', 'optimize:clear']],
                'artisan-migrate-status' => ['Migration status', ['php', 'artisan', 'migrate:status']],
                'artisan-migrate' => ['Apply migrations', ['php', 'artisan', 'migrate', '--force']],
                'artisan-storage-link' => ['Create storage link', ['php', 'artisan', 'storage:link']],
                'artisan-queue-restart' => ['Restart queue workers', ['php', 'artisan', 'queue:restart']],
            };
            return $step($label, $args, $command === 'artisan-migrate' ? 600 : 300);
        case 'symfony-cache-clear':
            $require($state['hasSymfonyConsole']);
            $require($available('php'), 'TOOL_UNAVAILABLE');
            return $step('Clear Symfony cache', ['php', 'bin/console', 'cache:clear', '--env=prod', '--no-debug'], 300);
        case 'wp-core-checksums':
        case 'wp-cache-flush':
        case 'wp-cron-run':
            $require($state['hasWordPress']);
            $require($available('wp'), 'TOOL_UNAVAILABLE');
            [$label, $args] = match ($command) {
                'wp-core-checksums' => ['Verify WordPress core', ['wp', 'core', 'verify-checksums']],
                'wp-cache-flush' => ['Flush WordPress cache', ['wp', 'cache', 'flush']],
                'wp-cron-run' => ['Run due WordPress cron events', ['wp', 'cron', 'event', 'run', '--due-now']],
            };
            return $step($label, $args, 300);
        case 'django-check-deploy':
        case 'django-migrate-status':
        case 'django-migrate':
        case 'django-collectstatic':
            $require($state['hasManagePy']);
            $require($available('python'), 'TOOL_UNAVAILABLE');
            if (is_array($python) && ($python['id'] ?? '') === 'pip') $require($state['hasPythonVenv']);
            [$label, $args] = match ($command) {
                'django-check-deploy' => ['Run Django deployment checks', [$py, 'manage.py', 'check', '--deploy']],
                'django-migrate-status' => ['Django migration plan', [$py, 'manage.py', 'migrate', '--plan']],
                'django-migrate' => ['Apply Django migrations', [$py, 'manage.py', 'migrate', '--noinput']],
                'django-collectstatic' => ['Collect Django static files', [$py, 'manage.py', 'collectstatic', '--noinput']],
            };
            return $step($label, $args, $command === 'django-check-deploy' ? 120 : 600);
        case 'compose-validate':
            return $composeStep('Validate configuration', ['config', '--quiet'], 60, false, false);
        case 'compose-up':
            return $composeStep('Start services', ['up', '-d', '--remove-orphans'], 900);
        case 'compose-deploy':
            return $composeStep('Build and start services', ['up', '-d', '--build', '--remove-orphans'], 900);
        case 'compose-restart':
            return $composeStep('Restart services', ['restart'], 300);
        case 'compose-pull':
            return $composeStep('Pull service images', ['pull', '--ignore-buildable'], 900);
        case 'compose-ps':
            return $composeStep('Verify service state', ['ps'], 60);
        case 'compose-logs':
            return $composeStep('Recent service logs', ['logs', '--tail', '200', '--no-color'], 60);
        case 'compose-down':
            return $composeStep('Stop project', ['down'], 300);
        case 'pm2-start':
            $require($available('pm2'), 'TOOL_UNAVAILABLE');
            if ($state['ecosystemFile'] !== null) {
                return $step('Start or reload ecosystem', ['pm2', 'startOrReload', $state['ecosystemFile']], 300);
            }
            $require($state['hasStartScript'] && is_array($manager) && empty($manager['ambiguous']));
            $require($available($manager['id']), 'TOOL_UNAVAILABLE');
            return $step('Start or reload application', ['pm2', 'start', $manager['id'], '--name', $state['processName'], '--', 'start'], 300);
        case 'pm2-restart':
            $require($available('pm2'), 'TOOL_UNAVAILABLE');
            return $step('Restart processes', ['pm2', 'restart', 'all', '--update-env'], 300);
        case 'pm2-stop':
            $require($available('pm2'), 'TOOL_UNAVAILABLE');
            return $step('Stop processes', ['pm2', 'stop', 'all'], 300);
        case 'pm2-delete':
            $require($available('pm2'), 'TOOL_UNAVAILABLE');
            return $step('Delete processes', ['pm2', 'delete', 'all'], 300);
        case 'pm2-restart-one':
        case 'pm2-stop-one':
        case 'pm2-delete-one':
            $require($available('pm2'), 'TOOL_UNAVAILABLE');
            $target = (string) ($operation['name'] ?? '');
            $require(preg_match('/^[A-Za-z0-9._-]{1,100}$/', $target) === 1, 'INVALID_REQUEST');
            $verb = substr($command, 4, -4);
            return $step(ucfirst($verb) . ' process', ['pm2', $verb, $target], 300);
        case 'pm2-save':
            $require($available('pm2'), 'TOOL_UNAVAILABLE');
            return $step('Persist process state', ['pm2', 'save', '--force'], 60);
        case 'pm2-status':
            $require($available('pm2'), 'TOOL_UNAVAILABLE');
            return $step('Process status', ['pm2', 'status'], 60);
        case 'pm2-logs':
            $require($available('pm2'), 'TOOL_UNAVAILABLE');
            return $step('Recent PM2 logs', ['pm2', 'logs', '--nostream', '--lines', '200'], 30);
        case 'upstream-check':
            $url = (string) $state['reverseProxyUrl'];
            $require(preg_match('#^https?://\S+$#', $url) === 1);
            $require($available('curl'), 'TOOL_UNAVAILABLE');
            return $step('Check upstream', ['curl', '-sS', '-o', '/dev/null', '--max-time', '10', '-w', 'HTTP %{http_code} in %{time_total}s\n', $url], 30);
    }
    respond(['ok' => false, 'code' => 'INVALID_ACTION']);
}

// Server-owned deployment plans. The client only names a plan; the exact
// steps, order, and arguments are decided here from the current detection
// snapshot and CloudPanel's configured site type. Destructive steps
// (database migrations) are deliberately never part of a plan.
function resolveDeploymentPlan(Site $site, array $state, string $plan): array
{
    $steps = static function (array $pairs) use (&$state): array {
        $resolved = [];
        foreach ($pairs as [$command, $label, $operation]) {
            $step = resolveOperationStep($state, $command, $operation ?? []);
            $step['label'] = $label;
            $resolved[] = $step;
        }
        return $resolved;
    };
    switch ($plan) {
        case 'compose':
            return $steps([
                ['compose-validate', 'Validate configuration', null],
                ['compose-deploy', 'Build and start services', null],
                ['compose-ps', 'Verify service state', null],
            ]);
        case 'node':
            if ($site->getType() !== Site::TYPE_NODEJS) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE']);
            return $steps(array_merge(
                [['node-install', 'Install dependencies', null]],
                $state['hasBuildScript'] ? [['node-run', 'Build application', ['script' => 'build']]] : [],
                [
                    ['pm2-start', 'Start or reload process', null],
                    ['pm2-save', 'Persist process state', null],
                ],
            ));
        case 'static-build':
            if ($site->getType() !== Site::TYPE_STATIC) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE']);
            return $steps([
                ['node-install', 'Install dependencies', null],
                ['node-run', 'Build static assets', ['script' => 'build']],
            ]);
        case 'php':
            if ($site->getType() !== Site::TYPE_PHP) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE']);
            $pairs = [];
            if ($state['hasPackageJson']) {
                $pairs[] = ['node-install', 'Install frontend dependencies', null];
                if ($state['hasBuildScript']) $pairs[] = ['node-run', 'Build frontend assets', ['script' => 'build']];
            }
            if ($state['hasComposer']) $pairs[] = ['composer-install-production', 'Install PHP dependencies', null];
            if ($state['hasArtisan']) $pairs[] = ['artisan-optimize', 'Build Laravel caches', null];
            if (!$pairs) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE']);
            return $steps($pairs);
        case 'python':
            if ($site->getType() !== Site::TYPE_PYTHON) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE']);
            $python = $state['pythonManager'];
            if (!is_array($python)) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE']);
            $pairs = [];
            if (($python['id'] ?? '') === 'pip' && !$state['hasPythonVenv']) {
                $pairs[] = ['python-create-venv', 'Create virtual environment', null];
                // The venv is created by the first step; let the install step
                // resolve against the state it will find at execution time.
                $state['hasPythonVenv'] = true;
                $state['venvPython'] = $state['path'] . '/.venv/bin/python';
            }
            $pairs[] = ['python-install', 'Sync Python dependencies', null];
            if ($state['hasManagePy']) $pairs[] = ['django-check-deploy', 'Run Django deployment checks', null];
            if ($state['hasEcosystem']) {
                $pairs[] = ['pm2-start', 'Start or reload process', null];
                $pairs[] = ['pm2-save', 'Persist process state', null];
            }
            return $steps($pairs);
    }
    respond(['ok' => false, 'code' => 'INVALID_ACTION']);
}

// --- Host software fixes -----------------------------------------------------
// One-click remediations for failed preflight checks. Super Admin-only, exact
// argument arrays, and installs always come from the official upstream source
// (Docker's APT repository, getcomposer.org with signature verification) so
// the latest supported release is installed instead of a stale distribution
// package. Each helper appends per-step results and returns false on the
// first failure.

function runFixStep(Site $site, array &$results, string $command, string $label, array $args, int $timeout): bool
{
    $result = runSiteCommand($site, $args, $timeout, true);
    $results[] = [
        'command' => $command,
        'label' => $label,
        'display' => implode(' ', $args),
        'exitCode' => $result['code'],
        'timedOut' => $result['timedOut'],
        'output' => trim($result['stdout'] . ($result['stderr'] !== '' ? "\n" . $result['stderr'] : '')),
    ];
    return $result['code'] === 0;
}

function syntheticFixStep(array &$results, string $command, string $label, string $display, bool $ok, string $output): bool
{
    $results[] = [
        'command' => $command,
        'label' => $label,
        'display' => $display,
        'exitCode' => $ok ? 0 : 1,
        'timedOut' => false,
        'output' => $output,
    ];
    return $ok;
}

// Configures Docker's official APT repository for the detected Debian/Ubuntu
// release so the newest Docker Engine and Compose plugin are installed, not
// the distribution's snapshot.
function configureDockerRepository(Site $site, string $fix, array &$results): bool
{
    $os = @parse_ini_file('/etc/os-release') ?: [];
    $id = strtolower((string) ($os['ID'] ?? ''));
    $codename = strtolower((string) ($os['VERSION_CODENAME'] ?? ''));
    if (!in_array($id, ['ubuntu', 'debian'], true) || !preg_match('/^[a-z]+$/', $codename)) {
        return syntheticFixStep($results, $fix, 'Detect operating system', 'read /etc/os-release', false,
            'Automatic Docker installation supports Debian and Ubuntu only.');
    }
    if (!runFixStep($site, $results, $fix, 'Prepare repository keyring', ['install', '-m', '0755', '-d', '/etc/apt/keyrings'], 60)) return false;
    if (!runFixStep($site, $results, $fix, "Download Docker's signing key", ['curl', '-fsSL', "https://download.docker.com/linux/$id/gpg", '-o', '/etc/apt/keyrings/docker.asc'], 120)) return false;
    @chmod('/etc/apt/keyrings/docker.asc', 0644);
    $arch = runSiteCommand($site, ['dpkg', '--print-architecture'], 30, true);
    $architecture = trim($arch['stdout']);
    if ($arch['code'] !== 0 || !preg_match('/^[a-z0-9]+$/', $architecture)) {
        return syntheticFixStep($results, $fix, 'Detect CPU architecture', 'dpkg --print-architecture', false, trim($arch['stderr']) ?: 'The package architecture could not be detected.');
    }
    $line = "deb [arch=$architecture signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$id $codename stable\n";
    $written = @file_put_contents('/etc/apt/sources.list.d/docker.list', $line) !== false;
    if (!syntheticFixStep($results, $fix, 'Configure Docker repository', 'write /etc/apt/sources.list.d/docker.list', $written, $written ? trim($line) : 'The repository definition could not be written.')) return false;
    return runFixStep($site, $results, $fix, 'Refresh package index', ['apt-get', 'update'], 600);
}

function executeFix(Site $site, string $fix, array &$results): void
{
    switch ($fix) {
        case 'install-docker':
            if (!runFixStep($site, $results, $fix, 'Install prerequisites', ['apt-get', 'install', '-y', 'ca-certificates', 'curl'], 600)) return;
            if (!configureDockerRepository($site, $fix, $results)) return;
            if (!runFixStep($site, $results, $fix, 'Install Docker Engine and Compose plugin', ['apt-get', 'install', '-y', 'docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin'], 900)) return;
            if (!runFixStep($site, $results, $fix, 'Enable and start the daemon', ['systemctl', 'enable', '--now', 'docker'], 120)) return;
            runFixStep($site, $results, $fix, 'Verify installation', ['docker', 'compose', 'version'], 60);
            return;
        case 'install-compose-plugin':
            if (!runFixStep($site, $results, $fix, 'Install prerequisites', ['apt-get', 'install', '-y', 'ca-certificates', 'curl'], 600)) return;
            if (!configureDockerRepository($site, $fix, $results)) return;
            if (!runFixStep($site, $results, $fix, 'Install Compose v2 plugin', ['apt-get', 'install', '-y', 'docker-compose-plugin', 'docker-buildx-plugin'], 900)) return;
            runFixStep($site, $results, $fix, 'Verify installation', ['docker', 'compose', 'version'], 60);
            return;
        case 'start-docker':
            if (!runFixStep($site, $results, $fix, 'Enable and start the daemon', ['systemctl', 'enable', '--now', 'docker'], 120)) return;
            runFixStep($site, $results, $fix, 'Verify daemon', ['docker', 'info', '--format', '{{.ServerVersion}}'], 60);
            return;
        case 'install-composer':
            $setup = '/tmp/panelavo-composer-setup.php';
            $signature = '/tmp/panelavo-composer-setup.sig';
            try {
                if (!runFixStep($site, $results, $fix, 'Download installer signature', ['curl', '-fsSL', 'https://composer.github.io/installer.sig', '-o', $signature], 120)) return;
                if (!runFixStep($site, $results, $fix, 'Download Composer installer', ['curl', '-fsSL', 'https://getcomposer.org/installer', '-o', $setup], 120)) return;
                $expected = trim((string) @file_get_contents($signature));
                $actual = is_file($setup) ? hash_file('sha384', $setup) : '';
                $verified = $expected !== '' && $actual !== '' && hash_equals($expected, $actual);
                if (!syntheticFixStep($results, $fix, 'Verify installer signature', 'sha384(installer) == installer.sig', $verified,
                    $verified ? 'The installer matches the published signature.' : 'The downloaded installer does not match the published signature; installation aborted.')) return;
                if (!runFixStep($site, $results, $fix, 'Install Composer', ['php', $setup, '--quiet', '--install-dir=/usr/local/bin', '--filename=composer'], 300)) return;
                runFixStep($site, $results, $fix, 'Verify installation', ['composer', '--version'], 60);
            } finally {
                @unlink($setup);
                @unlink($signature);
            }
            return;
    }
    respond(['ok' => false, 'code' => 'INVALID_ACTION']);
}

function readMeminfo(): array
{
    $values = [];
    foreach (preg_split('/\R/', (string) @file_get_contents('/proc/meminfo')) ?: [] as $line) {
        if (preg_match('/^(\w+):\s+(\d+)\s*kB/', $line, $m)) $values[$m[1]] = (int) $m[2] * 1024;
    }
    return $values;
}

// One shared ~500 ms sampling window measures the machine total AND each
// user's share the same way (utime+stime tick deltas from /proc), so the
// header percentage and the per-user rows are the same quantity and add up.
// ps's %cpu is a per-process LIFETIME average, which made idle machines show
// busy users — never use it for "current" CPU.
function sampleCpu(): array
{
    $readStat = function (): ?array {
        $line = strtok((string) @file_get_contents('/proc/stat'), "\n");
        if (!$line || !preg_match('/^cpu\s+(.+)$/', $line, $m)) return null;
        $parts = array_map('intval', preg_split('/\s+/', trim($m[1])));
        $idle = ($parts[3] ?? 0) + ($parts[4] ?? 0);
        return [array_sum($parts), $idle];
    };
    $readProcs = function (): array {
        $ticks = [];
        foreach (glob('/proc/[0-9]*/stat') ?: [] as $file) {
            $stat = @file_get_contents($file);
            if ($stat === false) continue;
            $close = strrpos($stat, ')');
            if ($close === false) continue;
            $fields = preg_split('/\s+/', trim(substr($stat, $close + 1)));
            $uid = @fileowner(dirname($file));
            if ($uid === false) continue;
            // Fields after the closing paren: state=0 … utime=11, stime=12.
            $ticks[(int) basename(dirname($file))] =
                [(int) $uid, (int) ($fields[11] ?? 0) + (int) ($fields[12] ?? 0)];
        }
        return $ticks;
    };

    $statA = $readStat();
    $procA = $readProcs();
    $t0 = microtime(true);
    usleep(500000);
    $statB = $readStat();
    $procB = $readProcs();
    $elapsed = max(0.05, microtime(true) - $t0);

    $usedPercent = 0.0;
    if ($statA && $statB && $statB[0] > $statA[0]) {
        $total = $statB[0] - $statA[0];
        $idle = $statB[1] - $statA[1];
        $usedPercent = round(max(0, min(100, (1 - $idle / max(1, $total)) * 100)), 1);
    }

    $hertz = (int) trim((string) shell_exec('getconf CLK_TCK 2>/dev/null'));
    if ($hertz <= 0) $hertz = 100;
    $byUid = [];
    foreach ($procB as $pid => [$uid, $t]) {
        if (!isset($procA[$pid])) continue;
        $delta = $t - $procA[$pid][1];
        if ($delta > 0) $byUid[$uid] = ($byUid[$uid] ?? 0) + $delta;
    }
    $byUser = [];
    foreach ($byUid as $uid => $ticksDelta) {
        $name = function_exists('posix_getpwuid')
            ? ((posix_getpwuid($uid)['name'] ?? null) ?: (string) $uid)
            : (string) $uid;
        // Single-core units (100 = one full core), matching capacity cores×100.
        $byUser[$name] = round($ticksDelta / $hertz / $elapsed * 100, 1);
    }
    return ['usedPercent' => $usedPercent, 'byUser' => $byUser];
}

function serverResources($manager): array
{
    $load = sys_getloadavg() ?: [0, 0, 0];
    $cores = max(1, (int) trim((string) shell_exec('nproc 2>/dev/null')));
    $mem = readMeminfo();
    $memTotal = $mem['MemTotal'] ?? 0;
    $memAvailable = $mem['MemAvailable'] ?? 0;
    $diskTotal = (float) disk_total_space('/');
    $diskFree = (float) disk_free_space('/');
    $uptime = (float) strtok((string) @file_get_contents('/proc/uptime'), ' ');

    // Current CPU, machine total and per user, from one sampling window.
    $cpuSample = sampleCpu();

    // Aggregate memory and process counts by system user (snapshot data — ps
    // is fine for these; its %cpu column is NOT used, see sampleCpu).
    $byUser = [];
    foreach (preg_split('/\R/', (string) shell_exec('ps -eo user:32,pcpu,pmem,rss --no-headers 2>/dev/null')) ?: [] as $line) {
        $parts = preg_split('/\s+/', trim($line));
        if (count($parts) < 4) continue;
        [$name, $cpu, $memPct, $rss] = $parts;
        $byUser[$name] ??= ['user' => $name, 'cpuPercent' => 0.0, 'memoryPercent' => 0.0, 'memoryBytes' => 0, 'processes' => 0];
        $byUser[$name]['memoryPercent'] += (float) $memPct;
        $byUser[$name]['memoryBytes'] += (int) $rss * 1024;
        $byUser[$name]['processes']++;
    }
    foreach ($cpuSample['byUser'] as $name => $percent) {
        $byUser[$name] ??= ['user' => $name, 'cpuPercent' => 0.0, 'memoryPercent' => 0.0, 'memoryBytes' => 0, 'processes' => 0];
        $byUser[$name]['cpuPercent'] = $percent;
    }

    // Site users: attach their domains and home-directory disk usage. du is
    // expensive, so results are cached for 10 minutes.
    $domainsByUser = [];
    foreach ($manager->getRepository(Site::class)->findAll() as $site) {
        $domainsByUser[$site->getUser()][] = $site->getDomainName();
    }
    $cacheFile = '/tmp/.panelavo-du-cache.json';
    $cache = null;
    if (is_file($cacheFile) && time() - (int) filemtime($cacheFile) < 600) {
        $cache = json_decode((string) file_get_contents($cacheFile), true);
    }
    if (!is_array($cache)) {
        $cache = [];
        foreach (array_keys($domainsByUser) as $siteUser) {
            if (!preg_match('/^[a-z_][a-z0-9._-]*$/', $siteUser)) continue;
            $output = shell_exec('timeout 10 du -sb --one-file-system ' . escapeshellarg('/home/' . $siteUser) . ' 2>/dev/null');
            if ($output && preg_match('/^(\d+)/', trim($output), $m)) $cache[$siteUser] = (int) $m[1];
        }
        @file_put_contents($cacheFile, json_encode($cache));
    }
    foreach ($domainsByUser as $siteUser => $domains) {
        $byUser[$siteUser] ??= ['user' => $siteUser, 'cpuPercent' => 0.0, 'memoryPercent' => 0.0, 'memoryBytes' => 0, 'processes' => 0];
        $byUser[$siteUser]['domains'] = $domains;
        if (isset($cache[$siteUser])) $byUser[$siteUser]['diskBytes'] = $cache[$siteUser];
    }
    $users = array_values($byUser);
    usort($users, fn($a, $b) => ($b['memoryBytes'] <=> $a['memoryBytes']));
    foreach ($users as &$entry) {
        $entry['cpuPercent'] = round($entry['cpuPercent'], 1);
        $entry['memoryPercent'] = round($entry['memoryPercent'], 1);
    }
    unset($entry);

    return [
        'generatedAt' => gmdate(DATE_ATOM),
        'uptimeSeconds' => (int) $uptime,
        'cpu' => [
            'cores' => $cores,
            'load1' => round((float) $load[0], 2),
            'load5' => round((float) $load[1], 2),
            'load15' => round((float) $load[2], 2),
            'usedPercent' => $cpuSample['usedPercent'],
        ],
        'memory' => [
            'totalBytes' => $memTotal,
            'usedBytes' => max(0, $memTotal - $memAvailable),
            'availableBytes' => $memAvailable,
            'usedPercent' => $memTotal ? round(($memTotal - $memAvailable) / $memTotal * 100, 1) : 0,
        ],
        'swap' => [
            'totalBytes' => $mem['SwapTotal'] ?? 0,
            'usedBytes' => max(0, ($mem['SwapTotal'] ?? 0) - ($mem['SwapFree'] ?? 0)),
        ],
        'disk' => [
            'totalBytes' => $diskTotal,
            'usedBytes' => max(0, $diskTotal - $diskFree),
            'availableBytes' => $diskFree,
            'usedPercent' => $diskTotal ? round(($diskTotal - $diskFree) / $diskTotal * 100, 1) : 0,
            'mount' => '/',
        ],
        'users' => array_slice($users, 0, 40),
    ];
}

function softwareVersion(string $command, string $pattern = '/(\d+\.\d+(?:\.\d+)*)/'): string
{
    $output = (string) shell_exec('timeout 5 ' . $command . ' 2>&1');
    return preg_match($pattern, $output, $m) ? $m[1] : '';
}

function serverInfo(): array
{
    $osRelease = @parse_ini_file('/etc/os-release');
    $cpuModel = '';
    foreach (preg_split('/\R/', (string) @file_get_contents('/proc/cpuinfo')) ?: [] as $line) {
        if (preg_match('/^model name\s*:\s*(.+)$/', $line, $m)) { $cpuModel = trim($m[1]); break; }
    }
    $mem = readMeminfo();
    $ip = trim((string) shell_exec("timeout 5 hostname -I 2>/dev/null | awk '{print $1}'"));
    $software = [];
    foreach ([
        ['CloudPanel', 'clpctl --version'],
        ['NGINX', 'nginx -v'],
        ['Node.js', 'node --version'],
        ['npm', 'npm --version'],
        ['PM2', 'pm2 --version'],
        ['PHP', 'php --version'],
        ['MySQL / MariaDB', 'mysql --version'],
        ['Git', 'git --version'],
        ['Docker', 'docker --version'],
        ['Docker Compose', 'docker compose version'],
        ['Python', 'python3 --version'],
        ['Composer', 'composer --version --no-ansi'],
        ['Redis', 'redis-server --version'],
        ['ProFTPD', 'proftpd --version'],
    ] as [$name, $command]) {
        $nodeBin = nodeBinPath('/root');
        $version = softwareVersion('env PATH=' . ($nodeBin ? $nodeBin . ':' : '') . '/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin ' . $command);
        if ($version !== '') $software[] = ['name' => $name, 'version' => $version];
    }
    return [
        'hostname' => (string) gethostname(),
        'os' => (string) ($osRelease['PRETTY_NAME'] ?? php_uname('s')),
        'kernel' => php_uname('r'),
        'arch' => php_uname('m'),
        'ip' => $ip,
        'uptimeSeconds' => (int) (float) strtok((string) @file_get_contents('/proc/uptime'), ' '),
        'cpuModel' => $cpuModel ?: 'unknown',
        'cpuCores' => max(1, (int) trim((string) shell_exec('nproc 2>/dev/null'))),
        'memoryTotalBytes' => $mem['MemTotal'] ?? 0,
        'diskTotalBytes' => (float) disk_total_space('/'),
        'software' => $software,
    ];
}

function runGit(Site $site, array $args, bool $allowFailure = false): array
{
    $cwd = realpath('/home/' . $site->getUser() . '/htdocs/' . $site->getRootDirectory());
    if (!$cwd) respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);
    $home = '/home/' . $site->getUser();
    $ssh = $home . '/.ssh';
    if (!is_dir($ssh) && mkdir($ssh, 0700, true)) {
        chown($ssh, $site->getUser()); chgrp($ssh, $site->getUser());
    }
    chmod($ssh, 0700); chown($ssh, $site->getUser()); chgrp($ssh, $site->getUser());
    $knownHosts = $ssh . '/known_hosts';
    if (is_file($knownHosts)) { chmod($knownHosts, 0600); chown($knownHosts, $site->getUser()); chgrp($knownHosts, $site->getUser()); }
    // Set the environment after sudo. Variables passed to proc_open can be
    // reset by sudo, causing SSH to use root's home or default host-key policy.
    $env = [
        '/usr/bin/env',
        'HOME=' . $home,
        'PATH=/usr/local/bin:/usr/bin:/bin',
        // Git runs without a terminal in the bridge. Trust a new SSH host on
        // first use, persist its key for later verification, and fail instead
        // of hanging when repository credentials are unavailable.
        'GIT_SSH_COMMAND=/usr/bin/ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=' . $knownHosts,
        'GIT_TERMINAL_PROMPT=0',
    ];
    $command = array_merge(['/usr/bin/timeout', '--signal=KILL', '285', '/usr/bin/sudo', '-n', '-u', $site->getUser(), '--'], $env, ['/usr/bin/git', '-c', 'safe.directory=' . $cwd], $args);
    $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd);
    if (!is_resource($process)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    fclose($pipes[0]); $stdout = stream_get_contents($pipes[1]); fclose($pipes[1]); $stderr = stream_get_contents($pipes[2]); fclose($pipes[2]); $code = proc_close($process);
    if ($code !== 0 && !$allowFailure) respond(['ok' => false, 'code' => 'GIT_FAILED', 'message' => trim($stderr ?: $stdout)]);
    return ['code' => $code, 'stdout' => substr($stdout ?: '', 0, 500000), 'stderr' => substr($stderr ?: '', 0, 50000)];
}

function gitSection(Site $site): array
{
    $root = '/home/' . $site->getUser() . '/htdocs/' . $site->getRootDirectory();
    $repo = is_dir($root . '/.git');
    if (!$repo) return ['isRepository' => false, 'path' => $root];
    $branch = trim(runGit($site, ['branch', '--show-current'], true)['stdout']);
    $head = trim(runGit($site, ['rev-parse', '--short', 'HEAD'], true)['stdout']);
    $remotesRaw = trim(runGit($site, ['remote', '-v'], true)['stdout']);
    $branchesRaw = trim(runGit($site, ['branch', '--format=%(refname:short)'], true)['stdout']);
    $statusRaw = trim(runGit($site, ['status', '--porcelain=v1'], true)['stdout']);
    $logRaw = trim(runGit($site, ['log', '-20', '--pretty=format:%h%x09%an%x09%ar%x09%s'], true)['stdout']);
    $diff = runGit($site, ['diff', '--no-color'], true)['stdout'];
    return ['isRepository' => true, 'path' => $root, 'branch' => $branch, 'head' => $head,
        'remotes' => array_values(array_filter(array_map(fn($line) => preg_split('/\s+/', $line), explode("\n", $remotesRaw)))),
        'branches' => $branchesRaw === '' ? [] : explode("\n", $branchesRaw),
        'changes' => $statusRaw === '' ? [] : array_map(fn($line) => ['status' => substr($line, 0, 2), 'path' => trim(substr($line, 3))], explode("\n", $statusRaw)),
        'commits' => $logRaw === '' ? [] : array_map(function ($line) { $p = explode("\t", $line, 4); return ['hash' => $p[0] ?? '', 'author' => $p[1] ?? '', 'date' => $p[2] ?? '', 'subject' => $p[3] ?? '']; }, explode("\n", $logRaw)),
        'diff' => substr($diff, 0, 200000)];
}

try {
    $input = json_decode(stream_get_contents(STDIN), true, 16, JSON_THROW_ON_ERROR);
    $kernel = new Kernel($_SERVER['APP_ENV'] ?? 'prod', false);
    $kernel->boot();
    $manager = $kernel->getContainer()->get('doctrine')->getManager();
    $user = $manager->getRepository(User::class)->findOneBy([
        'userName' => strtolower(trim((string) ($input['username'] ?? ''))),
    ]);

    if (!$user instanceof User || !$user->getStatus()) {
        respond(['ok' => false, 'code' => 'INVALID_CREDENTIALS']);
    }

    switch ($input['action'] ?? '') {
        case 'login':
            if (!password_verify((string) ($input['password'] ?? ''), $user->getPassword())) {
                respond(['ok' => false, 'code' => 'INVALID_CREDENTIALS']);
            }
            respond(['ok' => true, 'user' => publicUser($user)]);

        case 'mfa':
            $valid = $user->hasMfaEnabled()
                && (new MfaAuthenticator())->verifyCode(
                    $user->getMfaSecret(),
                    (string) ($input['code'] ?? '')
                );
            respond(['ok' => $valid, 'code' => $valid ? null : 'INVALID_TWO_FACTOR_CODE', 'user' => publicUser($user)]);

        case 'user':
            respond(['ok' => true, 'user' => publicUser($user)]);

        case 'sites':
            $sites = in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true)
                ? $manager->getRepository(Site::class)->findBy([], ['domainName' => 'ASC'])
                : $user->getSites()->toArray();
            respond(['ok' => true, 'sites' => array_map('publicSite', $sites)]);

        case 'users':
            if ($user->getRole() !== User::ROLE_ADMIN) respond(['ok' => false, 'code' => 'FORBIDDEN']);
            respond(['ok' => true, 'data' => ['users' => array_map('publicUser', $manager->getRepository(User::class)->findBy([], ['userName' => 'ASC']))]]);

        case 'manage-user':
            if ($user->getRole() !== User::ROLE_ADMIN) respond(['ok' => false, 'code' => 'FORBIDDEN']);
            $operation = $input['operation'] ?? [];
            $target = $manager->getRepository(User::class)->findOneBy(['userName' => strtolower(trim((string) ($operation['username'] ?? '')))]);
            if (!$target instanceof User) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
            $role = str_replace('-', '_', strtoupper((string) ($operation['role'] ?? 'user')));
            $role = 'ROLE_' . preg_replace('/^ROLE_/', '', $role);
            if (!in_array($role, [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER, User::ROLE_USER], true)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
            $target->setRole($role); $target->setStatus((bool) ($operation['status'] ?? true));
            if ($target->getId() === $user->getId() && !$target->getStatus()) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
            $target->removeSites();
            if ($role === User::ROLE_USER) foreach (($operation['sites'] ?? []) as $domain) { $assigned = $manager->getRepository(Site::class)->findOneBy(['domainName' => (string) $domain]); if ($assigned) $target->addSite($assigned); }
            $manager->flush(); respond(['ok' => true]);

        case 'assign-site':
            // Attach a site to the caller's collection. Used by the panel
            // right after a panel-admin (CloudPanel role "user" with the local
            // overlay) creates a site, so their restricted site list includes
            // everything they created. The Node caller enforces who may ask.
            $site = $manager->getRepository(Site::class)->findOneBy(['domainName' => (string) ($input['domain'] ?? '')]);
            if (!$site instanceof Site) respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);
            if (!$user->hasSite($site)) { $user->addSite($site); $manager->flush(); }
            respond(['ok' => true]);

        case 'update-profile':
            // Self-service profile update: the caller edits their own record.
            $profile = $input['profile'] ?? [];
            if (array_key_exists('firstName', $profile)) $user->setFirstName(trim(substr((string) $profile['firstName'], 0, 64)));
            if (array_key_exists('lastName', $profile)) $user->setLastName(trim(substr((string) $profile['lastName'], 0, 64)));
            if (array_key_exists('email', $profile)) {
                $email = trim((string) $profile['email']);
                if (!filter_var($email, FILTER_VALIDATE_EMAIL)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $user->setEmail($email);
            }
            if (array_key_exists('timezone', $profile) && method_exists($user, 'setTimezone')) {
                // setTimezone() takes a Timezone entity; resolve by name from
                // CloudPanel's timezone table.
                $timezone = $manager->getRepository(\App\Entity\Timezone::class)
                    ->findOneBy(['name' => (string) $profile['timezone']]);
                if (!$timezone) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $user->setTimezone($timezone);
            }
            $manager->flush();
            respond(['ok' => true, 'user' => publicUser($user)]);

        case 'server-resources':
            if (!in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true)) respond(['ok' => false, 'code' => 'FORBIDDEN']);
            respond(['ok' => true, 'data' => serverResources($manager)]);

        case 'server-info':
            if (!in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true)) respond(['ok' => false, 'code' => 'FORBIDDEN']);
            respond(['ok' => true, 'data' => serverInfo()]);

        case 'site':
            respond(['ok' => true, 'site' => publicSite(authorizedSite(
                $manager,
                $user,
                (string) ($input['domain'] ?? '')
            ))]);

        case 'site-section':
            $site = authorizedSite($manager, $user, (string) ($input['domain'] ?? ''));
            $section = (string) ($input['section'] ?? '');
            $data = match ($section) {
                'vhost' => ['content' => @file_get_contents('/etc/nginx/sites-enabled/' . $site->getDomainName() . '.conf') ?: ''],
                'databases' => ['items' => array_map(fn($db) => [
                    'id' => (string) $db->getId(),
                    'name' => $db->getName(),
                    'users' => array_map(fn($u) => $u->getUserName(), $db->getUsers()->toArray()),
                    'createdAt' => $db->getCreatedAt()?->format(DATE_ATOM),
                ], $site->getDatabases()->toArray())],
                // Certificate::TYPE_SELF_SIGNED = 1, TYPE_LETS_ENCRYPT = 2,
                // TYPE_IMPORTED = 3 — exported as semantic strings so no
                // consumer ever has to guess the numeric mapping again.
                'certificates' => ['items' => array_map(fn($cert) => [
                    'id' => (string) $cert->getId(),
                    'type' => match ((int) $cert->getType()) {
                        1 => 'self-signed',
                        2 => 'lets-encrypt',
                        3 => 'imported',
                        default => (string) $cert->getType(),
                    },
                    'domains' => $cert->getDomains(),
                    'expiresAt' => $cert->getExpiresAt()?->format(DATE_ATOM),
                    'default' => $cert->getDefaultCertificate(),
                ], $site->getCertificates()->toArray())],
                'security' => [
                    'blockedIps' => array_map(fn($item) => $item->getIp(), $site->getBlockedIps()->toArray()),
                    'blockedBots' => array_map(fn($item) => $item->getName(), $site->getBlockedBots()->toArray()),
                    'basicAuth' => $site->getBasicAuth() ? [
                        'active' => $site->getBasicAuth()->getIsActive(),
                        'username' => $site->getBasicAuth()->getUserName(),
                    ] : null,
                    'cloudflareOnly' => $site->allowTrafficFromCloudflareOnly(),
                ],
                'users' => [
                    'primary' => $site->getUser(),
                    'ssh' => array_map(fn($item) => $item->getUserName(), $site->getSshUsers()->toArray()),
                    'ftp' => array_map(fn($item) => ['username' => $item->getUserName(), 'home' => $item->getHomeDirectory()], $site->getFtpUsers()->toArray()),
                    'keyPair' => siteKeyPair($site),
                ],
                'file-manager' => fileManagerListing($site, null),
                'git' => gitSection($site),
                'actions' => actionsSection($site, $user),
                'cron-jobs' => ['sitePath' => '/home/' . $site->getUser() . '/htdocs/' . $site->getRootDirectory(), 'items' => array_map(fn($item) => ['id' => (string) $item->getId(), 'schedule' => $item->getSchedule(), 'command' => $item->getCommand(), 'expression' => $item->getCrontabExpression()], $site->getCronJobs()->toArray())],
                'logs' => (function () use ($site) {
                    $base = '/home/' . $site->getUser() . '/logs';
                    $files = array_merge(glob($base . '/*') ?: [], glob($base . '/*/*') ?: []);
                    return ['path' => $base, 'items' => array_values(array_map(fn($file) => substr($file, strlen($base) + 1), array_filter($files, 'is_file')))];
                })(),
                default => ['site' => publicSite($site)],
            };
            respond(['ok' => true, 'data' => $data]);

        case 'manage-section':
            $site = authorizedSite($manager, $user, (string) ($input['domain'] ?? ''));
            // panelAdmin is set by the trusted Node caller for overlay admins;
            // authorizedSite() above already proved the site is assigned to them.
            if (!in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true) && empty($input['panelAdmin'])) respond(['ok' => false, 'code' => 'FORBIDDEN']);
            $section = (string) ($input['section'] ?? '');
            $operation = $input['operation'] ?? [];
            $action = (string) ($operation['action'] ?? '');
            $model = $updater = null;
            if (!in_array($section, ['file-manager', 'logs', 'git', 'actions'], true) && !($section === 'users' && $action === 'generate-keypair')) {
                [$model, $updater] = siteModel($site);
            }

            if ($section === 'git') {
                $ref = (string) ($operation['branch'] ?? '');
                if ($ref !== '' && !preg_match('/^[A-Za-z0-9._\/-]{1,200}$/', $ref)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                if ($action === 'clone') {
                    $url = trim((string) ($operation['url'] ?? '')); if (!preg_match('#^(https://|git@)[^\s]+$#', $url)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    // Clone into the configured site root (htdocs/<root directory>),
                    // creating it first if CloudPanel has not materialized it yet,
                    // so the repository always lands in the folder the vhost serves.
                    $rootPath = siteRootPath($site);
                    if (!is_dir($rootPath)) {
                        if (!mkdir($rootPath, 0755, true)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                        chown($rootPath, $site->getUser()); chgrp($rootPath, $site->getUser());
                    }
                    $root = realpath($rootPath);
                    $entries = $root ? array_values(array_diff(scandir($root) ?: [], ['.', '..'])) : [];
                    $contentEntries = array_values(array_diff($entries, ['.well-known']));
                    if (!$root || $contentEntries) respond(['ok' => false, 'code' => 'DIRECTORY_NOT_EMPTY']);
                    if (in_array('.well-known', $entries, true)) {
                        // ACME creates .well-known before application code is
                        // deployed. Clone metadata into a temporary child,
                        // promote .git, then check out the working tree around
                        // the preserved challenge directory.
                        $temporary = '.panelavo-clone-' . bin2hex(random_bytes(8));
                        runGit($site, array_values(array_filter(['clone', '--no-checkout', $ref ? '--branch' : null, $ref ?: null, $url, $temporary])));
                        if (!rename($root . '/' . $temporary . '/.git', $root . '/.git')) respond(['ok' => false, 'code' => 'GIT_FAILED']);
                        rmdir($root . '/' . $temporary);
                        runGit($site, ['reset', '--hard', 'HEAD']);
                    } else {
                        runGit($site, array_values(array_filter(['clone', $ref ? '--branch' : null, $ref ?: null, $url, '.'])));
                    }
                } elseif ($action === 'init') runGit($site, ['init']);
                elseif ($action === 'set-remote') {
                    $url = trim((string) ($operation['url'] ?? '')); if (!preg_match('#^(https://|git@)[^\s]+$#', $url)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    runGit($site, ['remote', 'remove', 'origin'], true); runGit($site, ['remote', 'add', 'origin', $url]);
                } elseif ($action === 'fetch') runGit($site, ['fetch', '--prune', 'origin']);
                elseif ($action === 'pull') runGit($site, $ref ? ['pull', '--ff-only', 'origin', $ref] : ['pull', '--ff-only']);
                elseif ($action === 'push') runGit($site, $ref ? ['push', '-u', 'origin', $ref] : ['push']);
                elseif ($action === 'checkout') runGit($site, ['checkout', $ref]);
                elseif ($action === 'commit') { $message = trim((string) ($operation['message'] ?? '')); if ($message === '' || strlen($message) > 500) respond(['ok' => false, 'code' => 'INVALID_REQUEST']); runGit($site, ['add', '--all']); runGit($site, ['commit', '-m', $message]); }
                else respond(['ok' => false, 'code' => 'INVALID_ACTION']);
                respond(['ok' => true, 'data' => gitSection($site)]);
            } elseif ($section === 'users' && $action === 'generate-keypair') {
                $home = '/home/' . $site->getUser();
                $ssh = $home . '/.ssh';
                $key = $ssh . '/id_ed25519';
                if (!is_dir($ssh) && !mkdir($ssh, 0700, true)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                if (!is_file($key)) {
                    $process = proc_open(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', $site->getUser() . '@' . $site->getDomainName(), '-f', $key], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
                    if (!is_resource($process)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    fclose($pipes[0]); stream_get_contents($pipes[1]); fclose($pipes[1]); stream_get_contents($pipes[2]); fclose($pipes[2]);
                    if (proc_close($process) !== 0) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                }
                chmod($ssh, 0700); chmod($key, 0600); chmod($key . '.pub', 0644);
                chown($ssh, $site->getUser()); chgrp($ssh, $site->getUser()); chown($key, $site->getUser()); chgrp($key, $site->getUser()); chown($key . '.pub', $site->getUser()); chgrp($key . '.pub', $site->getUser());
                respond(['ok' => true, 'data' => ['keyPair' => siteKeyPair($site)]]);
            } elseif ($section === 'vhost' && $action === 'save') {
                $content = (string) ($operation['content'] ?? '');
                if (strlen($content) > 500000) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $site->setVhostTemplate($content);
                $model->setVhostTemplate($content);
                $updater->updateNginxVhostWithRollback();
            } elseif ($section === 'domains' && $action === 'sync') {
                // Alias domains + system-subdomain block mode, driven by the
                // panel's site-meta store (the Node side is the source of truth).
                $domainPattern = '/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/';
                $aliases = array_values(array_unique(array_map('strtolower', array_map('strval', (array) ($operation['aliases'] ?? [])))));
                if (count($aliases) > 10) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                foreach ($aliases as $alias) {
                    if (!preg_match($domainPattern, $alias) || $alias === $site->getDomainName()) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                }
                $block = (string) ($operation['block'] ?? 'none');
                if (!in_array($block, ['none', 'error', 'redirect'], true)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $redirectTo = strtolower((string) ($operation['redirectTo'] ?? ''));
                if ($block === 'redirect' && (!preg_match($domainPattern, $redirectTo) || $redirectTo === $site->getDomainName())) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $content = applyDomainConfig((string) $site->getVhostTemplate(), $aliases, $block, $site->getDomainName(), $redirectTo);
                $site->setVhostTemplate($content);
                $model->setVhostTemplate($content);
                $updater->updateNginxVhostWithRollback();
            } elseif ($section === 'security' && in_array($action, ['add-ip', 'add-bot'], true)) {
                $entity = $action === 'add-ip' ? new BlockedIp() : new BlockedBot();
                $entity->setSite($site);
                if ($entity instanceof BlockedIp) { $entity->setIp((string) $operation['value']); $site->addBlockedIp($entity); }
                else { $entity->setName((string) $operation['value']); $site->addBlockedBot($entity); }
                $manager->persist($entity);
                $updater->updateNginxVhostWithRollback();
            } elseif ($section === 'security' && in_array($action, ['delete-ip', 'delete-bot'], true)) {
                $class = $action === 'delete-ip' ? BlockedIp::class : BlockedBot::class;
                $field = $action === 'delete-ip' ? 'ip' : 'name';
                $entity = $manager->getRepository($class)->findOneBy(['site' => $site, $field => (string) $operation['value']]);
                if ($entity) $manager->remove($entity);
                $updater->updateNginxVhostWithRollback();
            } elseif ($section === 'security' && $action === 'basic-auth') {
                $entity = $site->getBasicAuth() ?: new BasicAuth();
                $entity->setSite($site);
                $entity->setIsActive((bool) ($operation['active'] ?? false));
                $entity->setUserName((string) ($operation['username'] ?? ''));
                if (!empty($operation['password'])) $entity->setPassword((string) $operation['password']);
                $site->setBasicAuth($entity);
                $model->setBasicAuth($entity);
                $manager->persist($entity);
                if ($entity->getIsActive()) $updater->createBasicAuthFile($entity);
                $updater->updateNginxVhostWithRollback();
            } elseif ($section === 'security' && $action === 'cloudflare') {
                $enabled = (bool) ($operation['enabled'] ?? false);
                $site->setAllowTrafficFromCloudflareOnly($enabled);
                $model->setAllowTrafficFromCloudflareOnly($enabled);
                $updater->updateNginxVhostWithRollback();
            } elseif ($section === 'users' && in_array($action, ['add-ssh', 'add-ftp'], true)) {
                $entity = $action === 'add-ssh' ? new SshUser() : new FtpUser();
                $entity->setSite($site);
                $entity->setUserName((string) $operation['username']);
                $entity->setPassword((string) $operation['password']);
                if ($entity instanceof SshUser) { $entity->setSshKeys((string) ($operation['sshKeys'] ?? '')); $site->addSshUser($entity); $updater->createSshUser($entity); }
                else { $entity->setHomeDirectory((string) ($operation['homeDirectory'] ?? '/home/' . $site->getUser())); $site->addFtpUser($entity); $updater->createFtpUser($entity); }
                $manager->persist($entity);
            } elseif ($section === 'users' && in_array($action, ['delete-ssh', 'delete-ftp'], true)) {
                $class = $action === 'delete-ssh' ? SshUser::class : FtpUser::class;
                $entity = $manager->getRepository($class)->findOneBy(['site' => $site, 'userName' => (string) $operation['username']]);
                if ($entity) { $updater->deleteUser($entity->getUserName()); $manager->remove($entity); }
            } elseif ($section === 'cron-jobs' && $action === 'add') {
                $parts = preg_split('/\s+/', trim((string) $operation['schedule']));
                if (count($parts) !== 5) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $commands = array_values(array_filter(array_map('trim', preg_split('/\R/', (string) ($operation['command'] ?? '')) ?: [])));
                if (!$commands || count($commands) > 20 || strlen(implode(' && ', $commands)) > 10000) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $entity = new CronJob(); $entity->setSite($site);
                $entity->setMinute($parts[0]); $entity->setHour($parts[1]); $entity->setDay($parts[2]); $entity->setMonth($parts[3]); $entity->setWeekday($parts[4]);
                $entity->setCommand(implode(' && ', $commands)); $site->addCronJob($entity); $manager->persist($entity); $updater->updateUserCrontab();
            } elseif ($section === 'cron-jobs' && $action === 'delete') {
                $entity = $manager->getRepository(CronJob::class)->find((int) $operation['id']);
                if ($entity && $entity->getSite()->getId() === $site->getId()) { $site->removeCronJob($entity); $manager->remove($entity); $updater->updateUserCrontab(); }
            } elseif ($section === 'certificates' && $action === 'set-default') {
                // Mark the chosen certificate as default and deploy it to the
                // fixed nginx path. A config test with rollback guarantees an
                // invalid certificate can never take the vhost down.
                $certId = (int) ($operation['id'] ?? 0);
                $target = null;
                foreach ($site->getCertificates() as $cert) {
                    $isTarget = $cert->getId() === $certId;
                    $cert->setDefaultCertificate($isTarget);
                    if ($isTarget) $target = $cert;
                }
                if (!$target) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $getCert = $getKey = null;
                foreach (['getCertificate', 'getCert', 'getCertificatePem'] as $m) if (method_exists($target, $m)) { $getCert = $m; break; }
                foreach (['getPrivateKey', 'getKey', 'getPrivateKeyPem'] as $m) if (method_exists($target, $m)) { $getKey = $m; break; }
                if (!$getCert || !$getKey) respond(['ok' => false, 'code' => 'INVALID_ACTION']);
                $chain = '';
                foreach (['getCertificateChain', 'getChain', 'getIntermediateCertificate', 'getCaBundle'] as $m) if (method_exists($target, $m)) { $chain = (string) $target->$m(); break; }
                $crt = rtrim((string) $target->$getCert()) . "\n";
                if (trim($chain) !== '') $crt .= rtrim($chain) . "\n";
                $key = rtrim((string) $target->$getKey()) . "\n";
                if (trim($crt) === '' || trim($key) === '') respond(['ok' => false, 'code' => 'INVALID_ACTION']);
                $dir = '/etc/nginx/ssl-certificates';
                $crtPath = $dir . '/' . $site->getDomainName() . '.crt';
                $keyPath = $dir . '/' . $site->getDomainName() . '.key';
                $backupCrt = @file_get_contents($crtPath);
                $backupKey = @file_get_contents($keyPath);
                file_put_contents($crtPath, $crt);
                file_put_contents($keyPath, $key);
                $testOutput = []; $testCode = 0;
                exec('nginx -t 2>&1', $testOutput, $testCode);
                if ($testCode !== 0) {
                    if ($backupCrt !== false) file_put_contents($crtPath, $backupCrt);
                    if ($backupKey !== false) file_put_contents($keyPath, $backupKey);
                    respond(['ok' => false, 'code' => 'CLOUDPANEL_UNAVAILABLE']);
                }
                exec('systemctl reload nginx 2>&1');
            } elseif ($section === 'actions') {
                if ($action === 'fix') {
                    // Host software repairs are a Super Admin boundary and are
                    // serialized host-wide: APT and systemd state is shared, so
                    // two concurrent fixes could corrupt each other.
                    if ($user->getRole() !== User::ROLE_ADMIN) respond(['ok' => false, 'code' => 'FORBIDDEN']);
                    $fix = (string) ($operation['fix'] ?? '');
                    $lock = @fopen('/var/lock/panelavo-host-fix.lock', 'c');
                    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) respond(['ok' => false, 'code' => 'OPERATION_BUSY']);
                    $startedAt = gmdate(DATE_ATOM);
                    $results = [];
                    executeFix($site, $fix, $results);
                    flock($lock, LOCK_UN);
                    fclose($lock);
                    $last = end($results);
                    respond(['ok' => true, 'data' => ['run' => [
                        'command' => $fix,
                        'display' => count($results) . ' repair step(s) executed',
                        'exitCode' => $last['exitCode'],
                        'timedOut' => $last['timedOut'],
                        'output' => implode("\n\n", array_map(
                            static fn(array $item) => '── ' . $item['label'] . ' (' . $item['display'] . ")\n" . ($item['output'] !== '' ? $item['output'] : '(no output)'),
                            $results,
                        )),
                        'startedAt' => $startedAt,
                        'finishedAt' => gmdate(DATE_ATOM),
                        'steps' => $results,
                    ]] + actionsSection($site, $user)]);
                }
                if (!in_array($action, ['run', 'deploy'], true)) respond(['ok' => false, 'code' => 'INVALID_ACTION']);
                $state = operationsState($site, $user);
                $plan = null;
                if ($action === 'run') {
                    $steps = [resolveOperationStep($state, (string) ($operation['command'] ?? ''), $operation)];
                } else {
                    $plan = (string) ($operation['plan'] ?? '');
                    $steps = resolveDeploymentPlan($site, $state, $plan);
                }
                // Rootful Docker Compose is a Super Admin (CloudPanel admin)
                // boundary; everything else needs the site-write access the
                // manage-section gate above already proved.
                foreach ($steps as $stepDefinition) {
                    if (!empty($stepDefinition['asRoot']) && $user->getRole() !== User::ROLE_ADMIN) {
                        respond(['ok' => false, 'code' => 'FORBIDDEN']);
                    }
                }
                // One operation per site at a time. The lock is released when
                // this process exits, so a crashed run can never wedge a site.
                $lock = @fopen('/var/lock/panelavo-operations-' . $site->getUser() . '.lock', 'c');
                if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) respond(['ok' => false, 'code' => 'OPERATION_BUSY']);
                $startedAt = gmdate(DATE_ATOM);
                $results = [];
                foreach ($steps as $stepDefinition) {
                    $result = runSiteCommand($site, $stepDefinition['args'], $stepDefinition['timeout'], !empty($stepDefinition['asRoot']));
                    $results[] = [
                        'command' => $stepDefinition['command'],
                        'label' => $stepDefinition['label'],
                        'display' => implode(' ', $stepDefinition['args']),
                        'exitCode' => $result['code'],
                        'timedOut' => $result['timedOut'],
                        'output' => trim($result['stdout'] . ($result['stderr'] !== '' ? "\n" . $result['stderr'] : '')),
                    ];
                    if ($result['code'] !== 0) break;
                }
                flock($lock, LOCK_UN);
                fclose($lock);
                $last = end($results);
                $run = [
                    'command' => $action === 'run' ? $results[0]['command'] : 'deploy',
                    'display' => $action === 'run' ? $results[0]['display'] : count($results) . ' of ' . count($steps) . ' plan step(s) executed',
                    'exitCode' => $last['exitCode'],
                    'timedOut' => $last['timedOut'],
                    'output' => $action === 'run' && count($results) === 1
                        ? $results[0]['output']
                        : implode("\n\n", array_map(
                            static fn(array $item) => '── ' . $item['label'] . ' (' . $item['display'] . ")\n" . ($item['output'] !== '' ? $item['output'] : '(no output)'),
                            $results,
                        )),
                    'startedAt' => $startedAt,
                    'finishedAt' => gmdate(DATE_ATOM),
                ];
                if ($action === 'deploy') {
                    $run['plan'] = $plan;
                    $run['steps'] = $results;
                }
                respond(['ok' => true, 'data' => ['run' => $run] + actionsSection($site, $user)]);
            } elseif ($section === 'file-manager') {
                $base = fileManagerBase($site);
                $relative = trim((string) ($operation['path'] ?? ''), '/');
                if ($action === 'list') respond(['ok' => true, 'data' => fileManagerListing($site, $relative)]);
                if ($action === 'read') {
                    $path = safeFileManagerPath($base, $relative);
                    if (!is_file($path) || filesize($path) > 5 * 1024 * 1024) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    $content = file_get_contents($path);
                    if (($operation['encoding'] ?? '') === 'base64') $content = base64_encode($content ?: '');
                    respond(['ok' => true, 'data' => ['content' => $content ?: '']]);
                }
                if ($action === 'paste') {
                    $directory = safeFileManagerPath($base, $relative);
                    $sourceRelative = trim((string) ($operation['source'] ?? ''), '/');
                    $source = safeFileManagerPath($base, $sourceRelative);
                    $destination = safeFileManagerPath($base, ($relative ? $relative . '/' : '') . basename($source), false);
                    if (!is_dir($directory) || file_exists($destination) || $source === $destination || str_starts_with($destination . '/', $source . '/')) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    if (($operation['mode'] ?? '') === 'cut') { if (!rename($source, $destination)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']); }
                    else copyTree($source, $destination);
                    respond(['ok' => true, 'data' => fileManagerListing($site, $relative)]);
                }
                $directory = safeFileManagerPath($base, $relative);
                $name = (string) ($operation['name'] ?? '');
                if (!is_dir($directory) || $name === '' || basename($name) !== $name || in_array($name, ['.', '..'], true)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $path = safeFileManagerPath($base, ($relative ? $relative . '/' : '') . $name, false);
                if ($action === 'new-file' && !file_exists($path)) file_put_contents($path, '');
                elseif ($action === 'new-folder' && !file_exists($path)) mkdir($path, 0770);
                elseif ($action === 'upload' && !is_dir($path)) {
                    $encoded = (string) ($operation['content'] ?? '');
                    if (strlen($encoded) > 89478488) respond(['ok' => false, 'code' => 'UPLOAD_TOO_LARGE']);
                    $decoded = base64_decode($encoded, true);
                    if ($decoded === false || strlen($decoded) > 64 * 1024 * 1024) respond(['ok' => false, 'code' => 'UPLOAD_TOO_LARGE']);
                    file_put_contents($path, $decoded);
                }
                elseif ($action === 'save-file' && is_file($path)) file_put_contents($path, (string) ($operation['content'] ?? ''));
                elseif ($action === 'rename' && file_exists($path)) {
                    $newName = (string) ($operation['newName'] ?? '');
                    if ($newName === '' || basename($newName) !== $newName) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    $destination = safeFileManagerPath($base, ($relative ? $relative . '/' : '') . $newName, false);
                    if (file_exists($destination) || !rename($path, $destination)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                } elseif ($action === 'duplicate' && file_exists($path)) {
                    $copyName = pathinfo($name, PATHINFO_FILENAME) . '-copy' . (pathinfo($name, PATHINFO_EXTENSION) ? '.' . pathinfo($name, PATHINFO_EXTENSION) : '');
                    $destination = safeFileManagerPath($base, ($relative ? $relative . '/' : '') . $copyName, false);
                    if (file_exists($destination) || is_dir($path) || !copy($path, $destination)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                } elseif ($action === 'chmod' && file_exists($path)) {
                    $mode = (string) ($operation['mode'] ?? '');
                    if (!preg_match('/^[0-7]{3,4}$/', $mode) || !chmod($path, octdec($mode))) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                } elseif ($action === 'compress' && file_exists($path)) {
                    $archiveName = (string) ($operation['archiveName'] ?? ($name . '.zip'));
                    if (!preg_match('/^.+\.(zip|7z|rar)$/i', $archiveName) || basename($archiveName) !== $archiveName) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    $destination = safeFileManagerPath($base, ($relative ? $relative . '/' : '') . $archiveName, false);
                    if (file_exists($destination)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    
                    $ext = strtolower(pathinfo($archiveName, PATHINFO_EXTENSION));
                    $command = [];
                    if ($ext === 'zip') {
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/zip', '-r', '-q', $destination, $name];
                    } elseif ($ext === '7z') {
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/7z', 'a', $destination, $name];
                    } elseif ($ext === 'rar') {
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/rar', 'a', $destination, $name];
                    }
                    $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, dirname($path), ['HOME' => '/home/' . $site->getUser(), 'PATH' => '/usr/local/bin:/usr/bin:/bin']);
                    if (!is_resource($process)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    fclose($pipes[0]); stream_get_contents($pipes[1]); fclose($pipes[1]); stream_get_contents($pipes[2]); fclose($pipes[2]);
                    if (proc_close($process) !== 0) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);

                } elseif ($action === 'extract' && is_file($path)) {
                    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
                    if (!preg_match('/^(zip|7z|rar)$/i', $ext)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    
                    $extractTo = trim((string) ($operation['extractTo'] ?? $relative));
                    $targetDirectory = safeFileManagerPath($base, $extractTo);
                    if (!is_dir($targetDirectory)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    
                    $command = [];
                    if ($ext === 'zip') {
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/unzip', '-q', '-o', $path, '-d', $targetDirectory];
                    } elseif ($ext === '7z') {
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/7z', 'x', '-y', '-o' . $targetDirectory, $path];
                    } elseif ($ext === 'rar') {
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/unrar', 'x', '-y', $path, $targetDirectory . '/'];
                    }
                    $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, dirname($path), ['HOME' => '/home/' . $site->getUser(), 'PATH' => '/usr/local/bin:/usr/bin:/bin']);
                    if (!is_resource($process)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    fclose($pipes[0]); stream_get_contents($pipes[1]); fclose($pipes[1]); stream_get_contents($pipes[2]); fclose($pipes[2]);
                    if (proc_close($process) !== 0) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                } elseif ($action === 'delete' && file_exists($path)) deleteTree($path);
                else respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                if (file_exists($path)) { chown($path, $site->getUser()); chgrp($path, $site->getUser()); }
                respond(['ok' => true, 'data' => fileManagerListing($site, $relative)]);
            } elseif ($section === 'logs' && $action === 'clear') {
                $base = realpath('/home/' . $site->getUser() . '/logs');
                $name = ltrim((string) ($operation['name'] ?? ''), '/');
                $path = $base . '/' . $name;
                $real = realpath($path);
                if (!$base || !$name || !$real || !is_file($real) || !str_starts_with($real, $base . '/')) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                file_put_contents($path, '');
            } elseif ($section === 'logs' && $action === 'read') {
                $base = realpath('/home/' . $site->getUser() . '/logs');
                $name = ltrim((string) ($operation['name'] ?? ''), '/');
                $real = $base ? realpath($base . '/' . $name) : false;
                if (!$base || !$name || !$real || !is_file($real) || !str_starts_with($real, $base . '/')) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $size = filesize($real) ?: 0;
                $handle = fopen($real, 'rb');
                if (!$handle) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                if ($size > 500000) fseek($handle, -500000, SEEK_END);
                $content = stream_get_contents($handle); fclose($handle);
                respond(['ok' => true, 'data' => ['name' => $name, 'content' => $content ?: '', 'truncated' => $size > 500000]]);
            } else respond(['ok' => false, 'code' => 'INVALID_ACTION']);
            $manager->flush();
            respond(['ok' => true]);

        case 'update-site':
            $site = authorizedSite($manager, $user, (string) ($input['domain'] ?? ''));
            if (!in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true) && empty($input['panelAdmin'])) {
                respond(['ok' => false, 'code' => 'FORBIDDEN']);
            }
            [$model, $updater] = siteModel($site);
            $settings = $input['settings'] ?? [];
            $runtimeChanged = false;
            if (array_key_exists('rootDirectory', $settings)) {
                $root = trim((string) $settings['rootDirectory'], '/');
                $site->setRootDirectory($root);
                $model->setRootDirectory($root);
            }
            if (array_key_exists('reverseProxyUrl', $settings) && $model instanceof ReverseProxySiteModel) {
                $site->setReverseProxyUrl((string) $settings['reverseProxyUrl']);
                $model->setReverseProxyUrl((string) $settings['reverseProxyUrl']);
            }
            if (array_key_exists('runtimeVersion', $settings)) {
                $version = (string) $settings['runtimeVersion'];
                if ($model instanceof NodejsSiteModel) {
                    $runtimeChanged = $site->getNodejsSettings()->getNodejsVersion() !== $version;
                    $site->getNodejsSettings()->setNodejsVersion($version);
                }
                if ($model instanceof PythonSiteModel) {
                    $runtimeChanged = $site->getPythonSettings()->getPythonVersion() !== $version;
                    $site->getPythonSettings()->setPythonVersion($version);
                }
                if ($model instanceof PhpSiteModel) {
                    $oldVersion = $site->getPhpSettings()->getPhpVersion();
                    $runtimeChanged = $oldVersion !== $version;
                    if ($runtimeChanged) $updater->changePhpVersion($oldVersion, $version);
                    $site->getPhpSettings()->setPhpVersion($version);
                }
            }
            if (array_key_exists('appPort', $settings)) {
                $port = (int) $settings['appPort'];
                if ($model instanceof NodejsSiteModel) $site->getNodejsSettings()->setPort($port);
                if ($model instanceof PythonSiteModel) $site->getPythonSettings()->setPort($port);
            }
            if ($model instanceof NodejsSiteModel) {
                if ($runtimeChanged) $updater->installNodejsVersion();
                $updater->nodejsSettings();
            } elseif ($model instanceof PythonSiteModel) {
                if ($runtimeChanged) $updater->writePythonVersionFile();
                $updater->pythonSettings();
            } elseif ($model instanceof PhpSiteModel) {
                $updater->phpSettings();
            } else {
                $updater->updateNginxVhostWithRollback();
            }
            $manager->flush();
            respond(['ok' => true, 'site' => publicSite($site)]);

        default:
            respond(['ok' => false, 'code' => 'INVALID_ACTION'], 2);
    }
} catch (Throwable $error) {
    error_log('CloudPanel bridge: ' . $error::class . ': ' . $error->getMessage());
    respond(['ok' => false, 'code' => 'BRIDGE_FAILED'], 1);
}
