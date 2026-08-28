<?php

declare(strict_types=1);

// Allow-listed local bridge for functionality that CloudPanel's public clpctl
// does not expose. The Next.js server invokes it as a root CLI process for
// authorized reads and tightly-scoped mutations; it never handles HTTP.

use App\Entity\Site;
use App\Entity\User;
use App\Entity\BlockedIp;
use App\Entity\BlockedBot;
use App\Entity\BasicAuth;
use App\Entity\SshUser;
use App\Entity\FtpUser;
use App\Entity\CronJob;
use App\Entity\DatabaseUser;
use App\Kernel;
use App\Database\Manager as DatabaseManager;
use App\Service\Crypto;
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
const PANELAVO_BROKER_PROTOCOL_VERSION = 23;
const PANELAVO_BROKER_MAX_INPUT_BYTES = 100663296;
const PANELAVO_ROOTLESS_MIGRATION_ROOT = '/var/lib/panelavo/rootless-migrations';
const PANELAVO_ROOTLESS_MIGRATION_TTL = 86400;
const PANELAVO_FRESH_SITE_SCAFFOLD_ROOT = '/var/lib/panelavo/fresh-site-scaffolds';
const PANELAVO_PORT_BACKUP_ROOT = '/var/lib/panelavo/port-source-backups';
const PANELAVO_DATABASE_GATEWAY_ROOT = '/var/lib/panelavo/database-gateway';
const PANELAVO_DATABASE_GATEWAY_STATE = PANELAVO_DATABASE_GATEWAY_ROOT . '/endpoints.json';
const PANELAVO_DATABASE_GATEWAY_ADMIN = PANELAVO_DATABASE_GATEWAY_ROOT . '/admin-credentials';
const PANELAVO_DATABASE_GATEWAY_STREAMS = '/etc/nginx/panelavo-streams';

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
    $relative ??= 'htdocs/' . configuredSiteRootDirectory($site);
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

// Creates (and owns as the site user) every missing directory level of a
// validated relative path, so uploads and extractions can target folders that
// do not exist yet. Symlinked levels are rejected and the final path is
// re-verified against the base after creation.
function ensureFileManagerDirectory(Site $site, string $base, string $relative): string
{
    $relative = trim(str_replace('\\', '/', $relative), '/');
    if ($relative === '') return $base;
    $parts = explode('/', $relative);
    foreach ($parts as $part) {
        if ($part === '' || $part === '.' || $part === '..') respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    }
    $path = $base;
    foreach ($parts as $part) {
        $path .= '/' . $part;
        if (is_link($path) || (file_exists($path) && !is_dir($path))) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
        if (!is_dir($path)) {
            if (!mkdir($path, 0770)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
            chown($path, $site->getUser());
            chgrp($path, $site->getUser());
        }
    }
    $real = realpath($path);
    if (!$real || ($real !== $base && !str_starts_with($real, $base . '/'))) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    return $real;
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



// --- Environment management ---------------------------------------------------
// One canonical view of a site's environment variables: dotenv files in the
// application root plus a marker-tagged, Panelavo-managed export block in the
// site user's ~/.profile. Saving keeps both sides in sync so applications get
// their variables whether they read .env themselves or inherit a login-shell
// environment (SSH, cron, terminal). PM2 launches through Operations also
// receive the .env variables directly (see dotenvOperationEnv), so nothing
// depends on the application parsing .env.

const PANELAVO_ENV_FILES = ['.env', '.env.local', '.env.production'];
const PANELAVO_PROFILE_START = '# >>> panelavo:env >>> managed by Panelavo — do not edit inside this block';
const PANELAVO_PROFILE_END = '# <<< panelavo:env <<<';

function parseEnvContent(string $content): array
{
    $entries = [];
    foreach (preg_split('/\R/', $content) ?: [] as $line) {
        $line = ltrim($line);
        if ($line === '' || str_starts_with($line, '#')) continue;
        if (str_starts_with($line, 'export ')) $line = ltrim(substr($line, 7));
        if (!preg_match('/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/', $line, $m)) continue;
        $value = trim($m[2]);
        if ($value !== '' && ($value[0] === '"' || $value[0] === "'")) {
            $quote = $value[0];
            if (strlen($value) >= 2 && str_ends_with($value, $quote)) {
                $value = substr($value, 1, -1);
                if ($quote === '"') $value = str_replace(['\\"', '\\n', '\\\\'], ['"', "\n", '\\'], $value);
            }
        } elseif (($hash = strpos($value, ' #')) !== false) {
            $value = rtrim(substr($value, 0, $hash));
        }
        $entries[$m[1]] = $value;
    }
    return $entries;
}

function formatEnvValue(string $value): string
{
    if ($value !== '' && preg_match('#^[A-Za-z0-9_@./:+,=-]+$#', $value)) return $value;
    return '"' . str_replace(['\\', '"', "\n"], ['\\\\', '\\"', '\\n'], $value) . '"';
}

// Rewrites a dotenv file in place: known keys keep their position, removed
// keys disappear, new keys are appended, and comments/unknown lines survive.
function renderEnvFile(string $existing, array $entries): string
{
    $out = [];
    $handled = [];
    foreach ($existing === '' ? [] : (preg_split('/\R/', $existing) ?: []) as $line) {
        $probe = ltrim($line);
        if (str_starts_with($probe, 'export ')) $probe = ltrim(substr($probe, 7));
        $key = preg_match('/^([A-Za-z_][A-Za-z0-9_]*)\s*=/', $probe, $m) ? $m[1] : null;
        if ($key === null) { $out[] = $line; continue; }
        if (!array_key_exists($key, $entries)) continue;
        if (!isset($handled[$key])) { $out[] = $key . '=' . formatEnvValue((string) $entries[$key]); $handled[$key] = true; }
    }
    foreach ($entries as $key => $value) {
        if (!isset($handled[$key])) $out[] = $key . '=' . formatEnvValue((string) $value);
    }
    while ($out && trim((string) end($out)) === '') array_pop($out);
    return $out ? implode("\n", $out) . "\n" : '';
}

function validateEnvEntries(mixed $submitted): array
{
    if (!is_array($submitted) || count($submitted) > 200) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    $entries = [];
    foreach ($submitted as $entry) {
        $key = is_array($entry) ? (string) ($entry['key'] ?? '') : '';
        $value = is_array($entry) ? (string) ($entry['value'] ?? '') : '';
        if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,127}$/', $key)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
        if (strlen($value) > 4096 || preg_match('/[\0\r\n]/', $value)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
        $entries[$key] = $value;
    }
    return $entries;
}

function siteProfilePath(Site $site): string
{
    return '/home/' . $site->getUser() . '/.profile';
}

function readSiteProfileEnv(Site $site): array
{
    $content = (string) @file_get_contents(siteProfilePath($site), false, null, 0, 262144);
    $inside = false;
    $block = [];
    foreach (preg_split('/\R/', $content) ?: [] as $line) {
        if (str_starts_with(trim($line), '# >>> panelavo:env >>>')) { $inside = true; continue; }
        if (trim($line) === PANELAVO_PROFILE_END) { $inside = false; continue; }
        if ($inside) $block[] = $line;
    }
    return parseEnvContent(implode("\n", $block));
}

// Replaces the managed export block (creating ~/.profile when missing) so a
// login shell — SSH, the panel terminal, cron — sees the same variables as
// the synced .env. Everything outside the markers is preserved verbatim.
function writeSiteProfileEnv(Site $site, array $entries): void
{
    $path = siteProfilePath($site);
    $content = (string) @file_get_contents($path, false, null, 0, 262144);
    $kept = [];
    $inside = false;
    foreach ($content === '' ? [] : (preg_split('/\R/', $content) ?: []) as $line) {
        if (str_starts_with(trim($line), '# >>> panelavo:env >>>')) { $inside = true; continue; }
        if (trim($line) === PANELAVO_PROFILE_END) { $inside = false; continue; }
        if (!$inside) $kept[] = $line;
    }
    while ($kept && trim((string) end($kept)) === '') array_pop($kept);
    $block = [PANELAVO_PROFILE_START];
    foreach ($entries as $key => $value) {
        $block[] = 'export ' . $key . "='" . str_replace("'", "'\\''", (string) $value) . "'";
    }
    $block[] = PANELAVO_PROFILE_END;
    $next = ($kept ? implode("\n", $kept) . "\n\n" : '') . implode("\n", $block) . "\n";
    if (@file_put_contents($path, $next) === false) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    @chmod($path, 0644);
    @chown($path, $site->getUser());
    @chgrp($path, $site->getUser());
}

function envSection(Site $site): array
{
    $root = siteRootPath($site);
    $files = [];
    foreach (PANELAVO_ENV_FILES as $name) {
        $path = $root . '/' . $name;
        $exists = is_file($path);
        $entries = [];
        if ($exists && filesize($path) <= 262144) {
            foreach (parseEnvContent((string) @file_get_contents($path)) as $key => $value) {
                $entries[] = ['key' => $key, 'value' => $value];
            }
        }
        $files[] = ['name' => $name, 'exists' => $exists, 'entries' => $entries];
    }
    $profile = [];
    foreach (readSiteProfileEnv($site) as $key => $value) $profile[] = ['key' => $key, 'value' => $value];
    return ['path' => $root, 'files' => $files, 'userEnv' => $profile, 'profilePath' => siteProfilePath($site)];
}

// Site-owned .env variables injected into PM2 launches so applications that
// never parse .env still start with their configured environment. Keys are
// restricted to the shape runSiteCommand accepts; oversized or unusual
// entries are skipped rather than failing the launch, and reserved process
// variables are never overridden.
function dotenvOperationEnv(string $root): array
{
    $path = $root . '/.env';
    if (!is_file($path) || filesize($path) > 262144) return [];
    $reserved = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'IFS', 'ENV', 'BASH_ENV'];
    $env = [];
    foreach (parseEnvContent((string) @file_get_contents($path)) as $key => $value) {
        if (!preg_match('/^[A-Z_][A-Z0-9_]{0,63}$/', $key)) continue;
        if (in_array($key, $reserved, true) || str_starts_with($key, 'LD_')) continue;
        if (strlen($value) > 500 || str_contains($value, "\0")) continue;
        $env[$key] = $value;
        if (count($env) >= 100) break;
    }
    return $env;
}

// --- Backups ------------------------------------------------------------------
// On-demand, on-server snapshots of a site: a gzip tar of the application root
// plus a clpctl gzip export of each selected database, under
// /home/<user>/backups/<id>/ with a manifest. Snapshots are browsable and
// downloadable through the File Manager (or SFTP/terminal for large ones), and
// the newest PANELAVO_BACKUP_RETENTION are kept. A backup is created
// atomically: any failed step removes the partial snapshot so a listed backup
// is always complete.

const PANELAVO_BACKUP_RETENTION = 10;

function backupsBase(Site $site): string
{
    $base = '/home/' . $site->getUser() . '/backups';
    if (!is_dir($base)) {
        if (!mkdir($base, 0750, true)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
        chown($base, $site->getUser());
        chgrp($base, $site->getUser());
    }
    $real = realpath($base);
    if (!$real) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    return $real;
}

function readBackupManifest(string $dir): ?array
{
    $data = json_decode((string) @file_get_contents($dir . '/manifest.json'), true);
    return is_array($data) ? $data : null;
}

function safeBackupDir(Site $site, string $id): string
{
    if (!preg_match('/^[A-Za-z0-9-]{1,64}$/', $id)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    $base = backupsBase($site);
    $dir = realpath($base . '/' . $id);
    if (!$dir || !str_starts_with($dir, $base . '/') || !is_dir($dir)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    return $dir;
}

function siteDatabaseNames(Site $site): array
{
    return array_values(array_map(static fn($db) => (string) $db->getName(), $site->getDatabases()->toArray()));
}

function backupsSection(Site $site): array
{
    $base = backupsBase($site);
    $items = [];
    foreach (glob($base . '/*', GLOB_ONLYDIR) ?: [] as $dir) {
        $manifest = readBackupManifest($dir);
        if (!$manifest) continue;
        $items[] = [
            'id' => (string) ($manifest['id'] ?? basename($dir)),
            'createdAt' => (string) ($manifest['createdAt'] ?? ''),
            'bytes' => (int) ($manifest['bytes'] ?? 0),
            'hasFiles' => !empty($manifest['files']),
            'databases' => array_values(array_map(
                static fn($db) => (string) ($db['name'] ?? ''),
                (array) ($manifest['databases'] ?? []),
            )),
            'note' => (string) ($manifest['note'] ?? ''),
        ];
    }
    usort($items, static fn($a, $b) => strcmp((string) $b['id'], (string) $a['id']));
    return [
        'path' => $base,
        'relativePath' => 'backups',
        'items' => $items,
        'databases' => siteDatabaseNames($site),
        'retention' => PANELAVO_BACKUP_RETENTION,
    ];
}

// Keeps the newest PANELAVO_BACKUP_RETENTION complete snapshots and removes the
// rest. Ids are UTC timestamps, so a reverse lexical sort is newest-first.
function pruneBackups(Site $site, int $retention = PANELAVO_BACKUP_RETENTION): void
{
    $base = backupsBase($site);
    $dirs = array_values(array_filter(
        glob($base . '/*', GLOB_ONLYDIR) ?: [],
        static fn($dir) => is_file($dir . '/manifest.json'),
    ));
    usort($dirs, static fn($a, $b) => strcmp($b, $a));
    $retention = max(1, min(100, $retention));
    foreach (array_slice($dirs, $retention) as $old) deleteTree($old);
}

function createBackup(Site $site, array $operation): array
{
    $base = backupsBase($site);
    $id = gmdate('Ymd-His');
    if (is_dir($base . '/' . $id)) $id .= '-' . bin2hex(random_bytes(2));
    $dir = $base . '/' . $id;
    if (!mkdir($dir, 0750)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    chown($dir, $site->getUser());
    chgrp($dir, $site->getUser());

    $manifest = [
        'id' => $id,
        'createdAt' => gmdate(DATE_ATOM),
        'siteType' => $site->getType(),
        'root' => 'htdocs/' . configuredSiteRootDirectory($site),
        'files' => null,
        'databases' => [],
        'bytes' => 0,
    ];
    $note = trim((string) ($operation['note'] ?? ''));
    if ($note !== '') $manifest['note'] = substr($note, 0, 200);

    // Any failure removes the partial snapshot: a listed backup is always whole.
    $abort = static function (string $message) use ($dir): never {
        deleteTree($dir);
        respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => $message]);
    };

    if (($operation['files'] ?? true) !== false) {
        $root = siteRootPath($site);
        if (!is_dir($root)) $abort('The application root does not exist yet.');
        $archive = $dir . '/files.tar.gz';
        $result = runSiteCommand($site, ['tar', 'czf', $archive, '-C', $root, '.'], 900);
        // GNU tar exit 1 means "files changed while reading" — the archive is
        // still usable, so only a hard error (2+) fails the backup.
        if ($result['code'] > 1) $abort('File archive failed: ' . (trim($result['stderr'] ?: $result['stdout']) ?: 'tar error'));
        $manifest['files'] = ['archive' => 'files.tar.gz', 'bytes' => is_file($archive) ? (int) filesize($archive) : 0];
    }

    $requested = $operation['databases'] ?? null;
    $siteDbs = siteDatabaseNames($site);
    $selected = is_array($requested)
        ? array_values(array_intersect($siteDbs, array_map('strval', $requested)))
        : $siteDbs;
    if ($selected) {
        if (!mkdir($dir . '/databases', 0750)) $abort('The database backup directory could not be created.');
        chown($dir . '/databases', $site->getUser());
        chgrp($dir . '/databases', $site->getUser());
        foreach ($selected as $name) {
            if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $name)) $abort('The database name "' . $name . '" is not supported for backup.');
            $file = $dir . '/databases/' . $name . '.sql.gz';
            $result = runSiteCommand($site, ['clpctl', 'db:export', '--databaseName=' . $name, '--file=' . $file], 900, true);
            if ($result['code'] !== 0 || !is_file($file)) $abort('Database export failed for "' . $name . '": ' . (trim($result['stderr'] ?: $result['stdout']) ?: 'clpctl error'));
            chown($file, $site->getUser());
            chgrp($file, $site->getUser());
            $manifest['databases'][] = ['name' => $name, 'file' => 'databases/' . $name . '.sql.gz', 'bytes' => (int) filesize($file)];
        }
    }

    $manifest['bytes'] = (int) ($manifest['files']['bytes'] ?? 0)
        + array_sum(array_map(static fn($db) => (int) $db['bytes'], $manifest['databases']));
    if (@file_put_contents($dir . '/manifest.json', json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) === false) {
        $abort('The backup manifest could not be written.');
    }
    chown($dir . '/manifest.json', $site->getUser());
    chgrp($dir . '/manifest.json', $site->getUser());
    $retention = (int) ($operation['retention'] ?? PANELAVO_BACKUP_RETENTION);
    pruneBackups($site, $retention);
    return backupsSection($site);
}

// Restores a snapshot over the live site. Files are extracted on top of the
// current tree (existing files are overwritten; files created after the backup
// are not removed). Databases are imported only into databases that still
// belong to this site — a database deleted since the backup is skipped because
// it cannot be recreated here without its credentials.
function restoreBackup(Site $site, array $operation): void
{
    $dir = safeBackupDir($site, (string) ($operation['id'] ?? ''));
    $manifest = readBackupManifest($dir);
    if (!$manifest) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    $scope = (string) ($operation['scope'] ?? 'all');
    if (!in_array($scope, ['all', 'files', 'databases'], true)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);

    if ($scope !== 'databases' && !empty($manifest['files'])) {
        $archive = realpath($dir . '/files.tar.gz');
        if ($archive && str_starts_with($archive, $dir . '/') && is_file($archive)) {
            $root = siteRootPath($site);
            if (!is_dir($root)) {
                if (!mkdir($root, 0755, true)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                chown($root, $site->getUser());
                chgrp($root, $site->getUser());
            }
            $result = runSiteCommand($site, ['tar', 'xzf', $archive, '-C', $root], 900);
            if ($result['code'] !== 0) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'File restore failed: ' . (trim($result['stderr'] ?: $result['stdout']) ?: 'tar error')]);
        }
    }

    if ($scope !== 'files') {
        $siteDbs = siteDatabaseNames($site);
        foreach ((array) ($manifest['databases'] ?? []) as $db) {
            $name = (string) ($db['name'] ?? '');
            if (!in_array($name, $siteDbs, true)) continue;
            $file = realpath($dir . '/' . (string) ($db['file'] ?? ''));
            if (!$file || !str_starts_with($file, $dir . '/') || !is_file($file)) continue;
            $result = runSiteCommand($site, ['clpctl', 'db:import', '--databaseName=' . $name, '--file=' . $file], 900, true);
            if ($result['code'] !== 0) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'Database restore failed for "' . $name . '": ' . (trim($result['stderr'] ?: $result['stdout']) ?: 'clpctl error')]);
        }
    }
}

function backupStagingDirectory(): string
{
    $uid = getenv('PANELAVO_CALLER_UID');
    $gid = getenv('PANELAVO_CALLER_GID');
    if (!is_string($uid) || !ctype_digit($uid) || !is_string($gid) || !ctype_digit($gid)) invalidBrokerRequest();
    $uid = (int) $uid; $gid = (int) $gid;
    if ($uid < 1 || $gid < 1) invalidBrokerRequest();
    $runtime = realpath('/run/user/' . $uid);
    if (!$runtime || is_link($runtime) || fileowner($runtime) !== $uid) invalidBrokerRequest();
    $directory = $runtime . '/panelavo-backup-staging';
    if (!is_dir($directory)) {
        if (!mkdir($directory, 0700)) invalidBrokerRequest();
        chown($directory, $uid); chgrp($directory, $gid); chmod($directory, 0700);
    }
    $real = realpath($directory);
    if (!$real || is_link($directory) || fileowner($real) !== $uid) invalidBrokerRequest();
    return $real;
}

function stageBackupBundle(Site $site, string $id): array
{
    $directory = safeBackupDir($site, $id);
    $staging = backupStagingDirectory();
    $path = $staging . '/' . bin2hex(random_bytes(16)) . '.tar.gz';
    $entries = ['manifest.json'];
    if (is_file($directory . '/files.tar.gz')) $entries[] = 'files.tar.gz';
    if (is_dir($directory . '/databases')) $entries[] = 'databases';
    $result = runSiteCommand($site, array_merge(['/usr/bin/tar', 'czf', $path, '-C', $directory], $entries), 900, true);
    if ($result['code'] !== 0 || !is_file($path)) {
        @unlink($path);
        respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The off-site transfer archive could not be created.']);
    }
    chown($path, (int) getenv('PANELAVO_CALLER_UID'));
    chgrp($path, (int) getenv('PANELAVO_CALLER_GID'));
    chmod($path, 0600);
    return ['path' => $path, 'bytes' => (int) filesize($path)];
}

function importBackupBundle(Site $site, string $id, string $submittedPath): void
{
    if (!preg_match('/^[A-Za-z0-9-]{1,64}$/', $id)) invalidBrokerRequest();
    $staging = backupStagingDirectory();
    $path = realpath($submittedPath);
    if (!$path || !str_starts_with($path, $staging . '/') || !is_file($path) || is_link($path)) invalidBrokerRequest();
    $base = backupsBase($site);
    $destination = $base . '/' . $id;
    if (is_dir($destination) && readBackupManifest($destination)) return;
    if (file_exists($destination)) invalidBrokerRequest();
    $names = runSiteCommand($site, ['/usr/bin/tar', 'tzf', $path], 300, true);
    if ($names['code'] !== 0) invalidBrokerRequest();
    foreach (preg_split('/\R/', trim($names['stdout'])) ?: [] as $name) {
        if ($name === '') continue;
        if (!preg_match('#^(manifest\.json|files\.tar\.gz|databases/?|databases/[A-Za-z0-9_-]{1,64}\.sql\.gz)$#', $name)) invalidBrokerRequest();
    }
    $listing = runSiteCommand($site, ['/usr/bin/tar', 'tvzf', $path], 300, true);
    if ($listing['code'] !== 0) invalidBrokerRequest();
    foreach (preg_split('/\R/', trim($listing['stdout'])) ?: [] as $line) {
        if ($line === '') continue;
        if (!in_array($line[0], ['-', 'd'], true)) invalidBrokerRequest();
    }
    $temporary = $base . '/.offsite-' . bin2hex(random_bytes(8));
    if (!mkdir($temporary, 0700)) invalidBrokerRequest();
    $abort = static function () use ($temporary): never {
        deleteTree($temporary);
        respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    };
    $extract = runSiteCommand($site, ['/usr/bin/tar', 'xzf', $path, '--no-same-owner', '--no-same-permissions', '-C', $temporary], 900, true);
    if ($extract['code'] !== 0) $abort();
    $manifest = readBackupManifest($temporary);
    if (!$manifest || (string) ($manifest['id'] ?? '') !== $id) $abort();
    $ownership = runSiteCommand($site, ['/usr/bin/chown', '-R', '--', $site->getUser() . ':' . $site->getUser(), $temporary], 300, true);
    if ($ownership['code'] !== 0 || !rename($temporary, $destination)) $abort();
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

function configuredSiteRootDirectory(Site $site): string
{
    global $input;
    $configured = array_key_exists('applicationRootDirectory', $input)
        && is_string($input['applicationRootDirectory'])
        ? $input['applicationRootDirectory']
        : (string) $site->getRootDirectory();
    $relative = trim(str_replace('\\', '/', $configured), '/');
    if (strlen($relative) > 200 || str_contains($relative, "\0")) {
        respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    }
    if ($relative !== '') {
        foreach (explode('/', $relative) as $part) {
            if ($part === '' || $part === '.' || $part === '..' || !preg_match('/^[A-Za-z0-9._-]+$/', $part)) {
                respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
            }
        }
    }
    return $relative;
}

function siteRootPath(Site $site): string
{
    $user = (string) $site->getUser();
    if (!preg_match('/^[A-Za-z0-9._-]{1,64}$/', $user)) {
        respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);
    }
    $base = realpath('/home/' . $user . '/htdocs');
    if (!$base || !is_dir($base)) respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);

    $relative = configuredSiteRootDirectory($site);

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
function runSiteCommand(Site $site, array $args, int $timeout = 300, bool $asRoot = false, array $extraEnv = [], ?string $workingDirectory = null): array
{
    $cwd = realpath($workingDirectory ?? siteRootPath($site));
    if (!$cwd) respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);
    // A caller-provided working directory must stay inside the site home.
    if ($workingDirectory !== null && !$asRoot && !pathIsContained($cwd, '/home/' . $site->getUser())) {
        respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    }
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
    foreach ($extraEnv as $key => $value) {
        if (!is_string($key) || !preg_match('/^[A-Z_][A-Z0-9_]{0,63}$/', $key)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
        $value = (string) $value;
        if (strlen($value) > 500 || str_contains($value, "\0")) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
        $env[] = $key . '=' . $value;
    }
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

function siteIdentity(Site $site): array
{
    $user = (string) $site->getUser();
    $record = function_exists('posix_getpwnam') ? posix_getpwnam($user) : false;
    if (!is_array($record) || !isset($record['uid'], $record['gid'])) {
        respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);
    }
    return ['user' => $user, 'uid' => (int) $record['uid'], 'gid' => (int) $record['gid'], 'home' => '/home/' . $user];
}

function pathIsSocket(string $path): bool
{
    clearstatcache(true, $path);
    return @filetype($path) === 'socket';
}

function subordinateRange(string $file, string $user): ?array
{
    $ranges = [];
    foreach (@file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $parts = explode(':', $line);
        if (count($parts) !== 3 || !ctype_digit($parts[1]) || !ctype_digit($parts[2])) continue;
        $ranges[] = ['user' => $parts[0], 'start' => (int) $parts[1], 'count' => (int) $parts[2]];
    }
    $owned = array_values(array_filter($ranges, static fn(array $range): bool => hash_equals($user, $range['user']) && $range['count'] >= 65536));
    if (count($owned) !== 1) return null;
    $selected = $owned[0];
    $selectedEnd = $selected['start'] + $selected['count'] - 1;
    foreach ($ranges as $range) {
        if (hash_equals($user, $range['user'])) continue;
        $end = $range['start'] + $range['count'] - 1;
        if ($selected['start'] <= $end && $range['start'] <= $selectedEnd) return null;
    }
    return ['start' => $selected['start'], 'count' => $selected['count']];
}

function uidmapHelperReady(string $path): bool
{
    $permissions = @fileperms($path);
    return is_executable($path) && @fileowner($path) === 0 && is_int($permissions) && ($permissions & 04000) !== 0;
}

function nextSubordinateStart(string $file): int
{
    $highest = 100000;
    foreach (@file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $parts = explode(':', $line);
        if (count($parts) !== 3 || !ctype_digit($parts[1]) || !ctype_digit($parts[2])) continue;
        $highest = max($highest, (int) $parts[1] + (int) $parts[2]);
    }
    return (int) (ceil($highest / 65536) * 65536);
}

function hasSubordinateEntry(string $file, string $user): bool
{
    foreach (@file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        if (str_starts_with($line, $user . ':')) return true;
    }
    return false;
}

function rootlessDockerEnvironment(Site $site, bool $systemd = false): array
{
    $identity = siteIdentity($site);
    $runtime = '/run/user/' . $identity['uid'];
    $environment = [
        'XDG_RUNTIME_DIR' => $runtime,
        'DOCKER_HOST' => 'unix://' . $runtime . '/docker.sock',
    ];
    if ($systemd) $environment['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=' . $runtime . '/bus';
    return $environment;
}

// Docker commands are deliberately pinned to the site user's private socket.
// There is no fallback to /var/run/docker.sock when the user daemon is absent.
function runRootlessDockerCommand(Site $site, array $args, int $timeout = 300, ?string $workingDirectory = null): array
{
    return runSiteCommand($site, $args, $timeout, false, rootlessDockerEnvironment($site), $workingDirectory);
}

function runRootlessSystemdCommand(Site $site, array $args, int $timeout = 120): array
{
    return runSiteCommand($site, $args, $timeout, false, rootlessDockerEnvironment($site, true), '/home/' . $site->getUser());
}

function rootlessMigrationPath(Site $site, string $suffix = 'manifest.json'): string
{
    if (!is_dir(PANELAVO_ROOTLESS_MIGRATION_ROOT)) {
        if (!@mkdir(PANELAVO_ROOTLESS_MIGRATION_ROOT, 0700, true)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    }
    if (is_link(PANELAVO_ROOTLESS_MIGRATION_ROOT)) respond(['ok' => false, 'code' => 'BROKER_INTEGRITY_FAILED']);
    @chmod(dirname(PANELAVO_ROOTLESS_MIGRATION_ROOT), 0755);
    @chmod(PANELAVO_ROOTLESS_MIGRATION_ROOT, 0700);
    return PANELAVO_ROOTLESS_MIGRATION_ROOT . '/' . hash('sha256', strtolower((string) $site->getDomainName())) . '-' . $suffix;
}

// The Buildx CLI plugin ships as a file, so its presence can be verified
// without a running daemon (unlike `docker buildx version`, which needs the
// rootless socket). Used to decide host provisioning before the site user's
// daemon exists.
function dockerBuildxPluginInstalled(Site $site): bool
{
    $home = '/home/' . $site->getUser();
    foreach ([
        '/usr/libexec/docker/cli-plugins/docker-buildx',
        '/usr/local/lib/docker/cli-plugins/docker-buildx',
        '/usr/lib/docker/cli-plugins/docker-buildx',
        $home . '/.docker/cli-plugins/docker-buildx',
    ] as $candidate) {
        if (is_executable($candidate)) return true;
    }
    return false;
}

// Host-level rootless readiness: the shared packages, kernel/init features, and
// subordinate ID ranges that only root (setup.sh or a Super Admin host fix) can
// provide. Deliberately independent of the site user's own daemon, so the panel
// can tell "the host is ready, this user just needs to bring up their runtime"
// (a site-write self-service action) apart from "the host itself is missing
// prerequisites" (a Super Admin host action). Never mutates anything.
function rootlessHostProvisioned(Site $site): array
{
    $identity = siteIdentity($site);
    $missing = [];
    $systemdHost = trim((string) @file_get_contents('/proc/1/comm')) === 'systemd';
    $cgroupV2Host = is_file('/sys/fs/cgroup/cgroup.controllers');
    if (!$systemdHost || !$cgroupV2Host) $missing[] = 'systemd with cgroup v2';
    if (!is_executable('/usr/bin/docker') && !is_executable('/usr/local/bin/docker')) $missing[] = 'the Docker CLI';
    if (!(uidmapHelperReady('/usr/bin/newuidmap') && uidmapHelperReady('/usr/bin/newgidmap'))) $missing[] = 'uidmap (newuidmap/newgidmap)';
    if (!is_executable('/usr/bin/dockerd-rootless-setuptool.sh')) $missing[] = 'Docker rootless extras';
    if (!is_executable('/usr/bin/slirp4netns') && !is_executable('/usr/bin/pasta')) $missing[] = 'a userspace network helper (slirp4netns or pasta)';
    if (!dockerBuildxPluginInstalled($site)) $missing[] = 'the Docker Buildx plugin';
    if (subordinateRange('/etc/subuid', $identity['user']) === null || subordinateRange('/etc/subgid', $identity['user']) === null) {
        $missing[] = 'a subordinate UID/GID range for the site user';
    }
    return ['ready' => $missing === [], 'missing' => $missing];
}

function rootlessCapability(Site $site): array
{
    $identity = siteIdentity($site);
    $runtime = '/run/user/' . $identity['uid'];
    $subuid = subordinateRange('/etc/subuid', $identity['user']);
    $subgid = subordinateRange('/etc/subgid', $identity['user']);
    $capability = [
        'mode' => 'rootless',
        'user' => $identity['user'],
        'uid' => $identity['uid'],
        'socket' => $runtime . '/docker.sock',
        'dataRoot' => $identity['home'] . '/.local/share/docker',
        'uidmapAvailable' => uidmapHelperReady('/usr/bin/newuidmap') && uidmapHelperReady('/usr/bin/newgidmap'),
        'rootlessExtrasAvailable' => is_executable('/usr/bin/dockerd-rootless-setuptool.sh'),
        'buildxAvailable' => false,
        'networkHelperAvailable' => is_executable('/usr/bin/slirp4netns') || is_executable('/usr/bin/pasta'),
        'subuidReady' => $subuid !== null,
        'subgidReady' => $subgid !== null,
        'subuid' => $subuid,
        'subgid' => $subgid,
        'runtimeDirectoryReady' => is_dir($runtime)
            && (int) (@fileowner($runtime) ?: -1) === $identity['uid']
            && (((int) @fileperms($runtime)) & 0777) === 0700,
        'userBusReady' => pathIsSocket($runtime . '/bus')
            && (int) (@fileowner($runtime . '/bus') ?: -1) === $identity['uid'],
        'socketReady' => pathIsSocket($runtime . '/docker.sock')
            && (int) (@fileowner($runtime . '/docker.sock') ?: -1) === $identity['uid']
            && ((((int) @fileperms($runtime . '/docker.sock')) & 0007) === 0),
        'daemonAvailable' => false,
        'securityRootless' => false,
    ];
    $linger = runSiteCommand($site, ['loginctl', 'show-user', $identity['user'], '--property=Linger', '--value'], 15, true);
    $capability['lingerEnabled'] = $linger['code'] === 0 && trim($linger['stdout']) === 'yes';
    if ($capability['socketReady']) {
        $buildx = runRootlessDockerCommand($site, ['docker', 'buildx', 'version'], 20);
        $capability['buildxAvailable'] = $buildx['code'] === 0;
        $info = runRootlessDockerCommand($site, ['docker', 'info', '--format', '{{json .}}'], 20);
        $decoded = $info['code'] === 0 ? json_decode(trim($info['stdout']), true) : null;
        $capability['daemonAvailable'] = is_array($decoded);
        if (is_array($decoded)) {
            $security = array_map('strval', (array) ($decoded['SecurityOptions'] ?? []));
            $capability['securityRootless'] = count(array_filter($security, static fn(string $value): bool => str_contains(strtolower($value), 'rootless'))) > 0;
            $capability['serverVersion'] = (string) ($decoded['ServerVersion'] ?? '');
            $capability['storageDriver'] = (string) ($decoded['Driver'] ?? '');
            $capability['cgroupDriver'] = (string) ($decoded['CgroupDriver'] ?? '');
            $capability['cgroupVersion'] = (string) ($decoded['CgroupVersion'] ?? '');
            $capability['dockerRootDir'] = (string) ($decoded['DockerRootDir'] ?? $capability['dataRoot']);
            $capability['cgroupReady'] = ($decoded['CgroupVersion'] ?? null) === '2' || ($decoded['CgroupVersion'] ?? null) === 2;
            $capability['storageReady'] = rootlessStorageDriverReady((string) ($decoded['Driver'] ?? ''));
        }
        $usage = runRootlessDockerCommand($site, ['docker', 'system', 'df', '--format', '{{json .}}'], 20);
        if ($usage['code'] === 0) {
            $capability['diskUsage'] = substr(trim($usage['stdout']), 0, 20000);
            foreach (preg_split('/\R/', trim($usage['stdout'])) ?: [] as $line) {
                $row = json_decode($line, true);
                if (is_array($row) && strtolower((string) ($row['Type'] ?? '')) === 'images') {
                    $capability['imageUsage'] = (string) ($row['Size'] ?? '');
                    $capability['imageReclaimable'] = (string) ($row['Reclaimable'] ?? '');
                    break;
                }
            }
        }
    }
    $space = @disk_free_space($identity['home']);
    $capability['availableBytes'] = $space === false ? null : (int) $space;
    $capability['buildxHostReady'] = dockerBuildxPluginInstalled($site);
    $capability['hostRootlessReady'] = rootlessHostProvisioned($site)['ready'];
    $capability['ready'] = $capability['uidmapAvailable']
        && $capability['rootlessExtrasAvailable']
        && $capability['buildxAvailable']
        && $capability['networkHelperAvailable']
        && $capability['subuidReady'] && $capability['subgidReady']
        && $capability['lingerEnabled'] && $capability['runtimeDirectoryReady']
        && $capability['userBusReady'] && $capability['socketReady']
        && $capability['daemonAvailable'] && $capability['securityRootless']
        && !empty($capability['cgroupReady']) && !empty($capability['storageReady']);
    return $capability;
}

function rootlessStorageDriverReady(string $driver): bool
{
    return in_array(strtolower(trim($driver)), ['overlay2', 'overlayfs', 'fuse-overlayfs'], true);
}

function cleanupRootlessDockerBeforeSiteDelete(Site $site): void
{
    $identity = siteIdentity($site);
    $runtime = '/run/user/' . $identity['uid'];
    $dataRoot = $identity['home'] . '/.local/share/docker';
    $unit = $identity['home'] . '/.config/systemd/user/docker.service';
    $manifest = rootlessMigrationPath($site);
    $journal = rootlessMigrationPath($site, 'ownership.journal');
    if (!pathIsSocket($runtime . '/docker.sock') && !is_dir($dataRoot) && !is_file($unit) && !is_file($manifest) && !is_file($journal)) return;
    if (pathIsSocket($runtime . '/docker.sock')) {
        $containers = runRootlessDockerCommand($site, ['docker', 'ps', '-aq'], 30);
        $ids = preg_split('/\s+/', trim($containers['stdout'])) ?: [];
        $ids = array_values(array_filter($ids, static fn(string $id): bool => preg_match('/^[0-9a-f]{12,64}$/i', $id) === 1));
        if ($ids) {
            $remove = runRootlessDockerCommand($site, array_merge(['docker', 'rm', '-f'], $ids), 300);
            if ($remove['code'] !== 0) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The site user Docker containers could not be removed before website deletion.']);
        }
        $prune = runRootlessDockerCommand($site, ['docker', 'system', 'prune', '--all', '--force', '--volumes'], 300);
        if ($prune['code'] !== 0) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The site user Docker data could not be cleaned before website deletion.']);
    }
    if (pathIsSocket($runtime . '/bus')) {
        $stop = runRootlessSystemdCommand($site, ['systemctl', '--user', 'disable', '--now', 'docker.service'], 120);
        if ($stop['code'] !== 0 && pathIsSocket($runtime . '/docker.sock')) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The site user Docker service could not be stopped before website deletion.']);
    }
    if (is_dir($dataRoot)) deleteTree($dataRoot);
    @unlink($manifest); @unlink($journal);
    $linger = runSiteCommand($site, ['loginctl', 'disable-linger', $identity['user']], 60, true);
    if ($linger['code'] !== 0) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The site user linger state could not be removed before website deletion.']);
    runSiteCommand($site, ['systemctl', 'stop', 'user@' . $identity['uid'] . '.service'], 60, true);
    clearstatcache(true, $runtime . '/docker.sock');
    if (pathIsSocket($runtime . '/docker.sock')) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The site user Docker socket is still active; website deletion was stopped safely.']);
}

// Panel terminal: runs one user-supplied command line strictly as the
// unprivileged site user through a login shell (so ~/.profile — including the
// Panelavo-managed environment block — is loaded), with a bounded timeout and
// a working directory locked inside the site home. The final working
// directory is captured through a per-invocation random marker so `cd`
// persists across commands. This is the same privilege boundary as the site
// user's own SSH access; it never elevates.
function runTerminalCommand(Site $site, string $command, ?string $requestedCwd): array
{
    $home = '/home/' . $site->getUser();
    if ($command === '' || strlen($command) > 4000 || str_contains($command, "\0")) {
        respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    }
    $cwd = siteRootPath($site);
    if (is_string($requestedCwd) && $requestedCwd !== '') {
        if (strlen($requestedCwd) > 512 || str_contains($requestedCwd, "\0")) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
        $resolved = realpath($requestedCwd);
        if (!$resolved || !is_dir($resolved) || !pathIsContained($resolved, $home)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
        $cwd = $resolved;
    }
    $marker = 'PANELAVO_CWD_' . bin2hex(random_bytes(12));
    // /etc/profile resets PATH in login shells, so the site tool directories
    // (nvm Node.js, Composer, Bun, …) are re-prepended after profiles load.
    $wrapped = 'export PATH=' . escapeshellarg(implode(':', sitePathDirs($home))) . ':"$PATH"' . "\n"
        . $command . "\n"
        . '__panelavo_status=$?' . "\n"
        . 'printf "\n%s%s" ' . escapeshellarg($marker) . ' "$PWD"' . "\n"
        . 'exit $__panelavo_status';
    $result = runSiteCommand(
        $site,
        ['bash', '-l', '-c', $wrapped],
        180,
        false,
        ['TERM' => 'xterm-256color'],
        $cwd,
    );
    $output = $result['stdout'];
    $nextCwd = $cwd;
    $position = strrpos($output, $marker);
    if ($position !== false) {
        $candidate = trim(substr($output, $position + strlen($marker)));
        $output = rtrim(substr($output, 0, $position), "\n");
        $candidateReal = $candidate !== '' ? realpath($candidate) : false;
        if ($candidateReal && is_dir($candidateReal) && pathIsContained($candidateReal, $home)) $nextCwd = $candidateReal;
    }
    if ($result['stderr'] !== '') $output .= ($output !== '' ? "\n" : '') . $result['stderr'];
    return [
        'exitCode' => $result['code'],
        'timedOut' => $result['timedOut'],
        'output' => $output,
        'cwd' => $nextCwd,
    ];
}

// The four Compose filenames Panelavo recognizes, in priority order.
const COMPOSE_CANDIDATES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

// Locates the site's Compose file relative to the application root. The root is
// the canonical location and always wins, but projects commonly keep their
// Compose file in a dedicated subfolder (docker/, deploy/, .docker/, …), so when
// no root candidate exists a bounded, breadth-first scan looks for one. The
// scan is deterministic (alphabetical, shallowest-first) and skips dependency
// and VCS trees so a Compose file vendored by a dependency is never mistaken for
// the site's own. The returned path is always relative to $root (e.g.
// "docker/compose.yaml"), so every `docker compose -f` invocation — which runs
// with the application root as its working directory — and the host-safety scan
// keep resolving against the application root.
function findComposeFile(string $root): ?string
{
    foreach (COMPOSE_CANDIDATES as $candidate) {
        if (is_file($root . '/' . $candidate)) return $candidate;
    }
    $ignored = ['node_modules', 'vendor', '.git', '.svn', '.hg', 'backups', 'storage', 'cache', '.cache', 'tmp'];
    $maxDepth = 3;
    $queue = [['dir' => $root, 'rel' => '', 'depth' => 0]];
    while ($queue) {
        $node = array_shift($queue);
        if ($node['depth'] >= $maxDepth) continue;
        $entries = @scandir($node['dir']);
        if ($entries === false) continue;
        sort($entries, SORT_STRING);
        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') continue;
            $path = $node['dir'] . '/' . $entry;
            if (is_link($path) || !is_dir($path) || in_array($entry, $ignored, true)) continue;
            $rel = ($node['rel'] === '' ? '' : $node['rel'] . '/') . $entry;
            foreach (COMPOSE_CANDIDATES as $candidate) {
                if (is_file($path . '/' . $candidate)) return $rel . '/' . $candidate;
            }
            $queue[] = ['dir' => $path, 'rel' => $rel, 'depth' => $node['depth'] + 1];
        }
    }
    return null;
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
    if (findComposeFile($root) !== null) return 'Docker Compose';
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

function expectedSitePort(Site $site): ?int
{
    $port = $site->getNodejsSettings()?->getPort() ?? $site->getPythonSettings()?->getPort();
    if (is_numeric($port) && (int) $port >= 1 && (int) $port <= 65535) return (int) $port;
    $url = (string) ($site->getReverseProxyUrl() ?? '');
    if ($url === '') return null;
    $parts = parse_url($url);
    $host = strtolower(trim((string) ($parts['host'] ?? ''), '[]'));
    if (!in_array($host, ['127.0.0.1', 'localhost', '::1'], true)) return null;
    $port = $parts['port'] ?? (($parts['scheme'] ?? '') === 'https' ? 443 : 80);
    return is_numeric($port) && (int) $port >= 1 && (int) $port <= 65535 ? (int) $port : null;
}

function hostReservedPorts($manager): array
{
    $ports = [];
    // Public and private listener pools are fixed so adding a database
    // endpoint never restarts the shared proxy. They remain unavailable to
    // website runtimes even while a slot is idle.
    for ($port = 43000; $port <= 43255; $port++) $ports[$port] = true;
    for ($port = 44000; $port <= 44255; $port++) $ports[$port] = true;
    foreach ($manager->getRepository(Site::class)->findAll() as $site) {
        if (!$site instanceof Site) continue;
        $port = expectedSitePort($site);
        if ($port !== null) $ports[$port] = true;
    }
    foreach (glob('/etc/php/*/fpm/pool.d/*.conf') ?: [] as $pool) {
        if (is_link($pool) || !is_file($pool)) continue;
        foreach (preg_split('/\R/', (string) @file_get_contents($pool)) ?: [] as $line) {
            if (!preg_match('/^\s*listen\s*=\s*(?:\[[^]]+\]|[^:;\s]+)?:(\d{1,5})\s*(?:;.*)?$/', $line, $match)
                && !preg_match('/^\s*listen\s*=\s*(\d{1,5})\s*(?:;.*)?$/', $line, $match)) continue;
            $port = (int) $match[1];
            if ($port >= 1 && $port <= 65535) $ports[$port] = true;
        }
    }
    foreach (['/proc/net/tcp', '/proc/net/tcp6'] as $table) {
        foreach (array_slice(preg_split('/\R/', (string) @file_get_contents($table)) ?: [], 1) as $line) {
            $columns = preg_split('/\s+/', trim($line));
            if (count($columns) < 4 || $columns[3] !== '0A' || !str_contains($columns[1], ':')) continue;
            $port = hexdec((string) substr(strrchr($columns[1], ':'), 1));
            if ($port >= 1 && $port <= 65535) $ports[$port] = true;
        }
    }
    $result = array_map('intval', array_keys($ports));
    sort($result);
    return $result;
}

function requestedSitePort(array $siteInput): ?int
{
    if (isset($siteInput['appPort'])) return brokerPortValue($siteInput['appPort']);
    $url = $siteInput['reverseProxyUrl'] ?? null;
    if (!is_string($url)) return null;
    $parts = parse_url($url);
    $host = strtolower(trim((string) ($parts['host'] ?? ''), '[]'));
    if (!in_array($host, ['127.0.0.1', 'localhost', '::1'], true)) return null;
    $port = $parts['port'] ?? (($parts['scheme'] ?? '') === 'https' ? 443 : 80);
    return is_numeric($port) ? brokerPortValue($port) : null;
}

// Read listening sockets once from the host and mark the processes that are
// owned by this site's Unix user. The UI receives only port numbers and a safe
// summary; PIDs and command lines never leave the bridge.
function hostListeningPorts(Site $site): array
{
    $binary = is_executable('/usr/bin/ss') ? '/usr/bin/ss' : (is_executable('/usr/sbin/ss') ? '/usr/sbin/ss' : null);
    if (!$binary) return [];
    $result = runSiteCommand($site, [$binary, '-H', '-ltnp'], 15, true);
    if ($result['code'] !== 0) return [];
    $account = function_exists('posix_getpwnam') ? posix_getpwnam((string) $site->getUser()) : false;
    $siteUid = is_array($account) ? (int) ($account['uid'] ?? -1) : -1;
    $root = siteRootPath($site);
    $items = [];
    foreach (preg_split('/\R/', trim($result['stdout'])) ?: [] as $line) {
        $parts = preg_split('/\s+/', trim($line), 6);
        if (count($parts) < 4 || !preg_match('/:(\d+)$/', (string) $parts[3], $match)) continue;
        $port = (int) $match[1];
        if ($port < 1 || $port > 65535) continue;
        $siteOwned = false;
        $process = '';
        if (isset($parts[5])) {
            if (preg_match('/\(\("([^"]{1,80})"/', $parts[5], $name)) $process = $name[1];
            preg_match_all('/pid=(\d+)/', $parts[5], $pids);
            foreach ($pids[1] ?? [] as $pidText) {
                $pid = (int) $pidText;
                $uid = @fileowner('/proc/' . $pid);
                $cwd = @realpath('/proc/' . $pid . '/cwd');
                if (($siteUid >= 0 && $uid === $siteUid) || (is_string($cwd) && pathIsContained($cwd, $root))) {
                    $siteOwned = true;
                    break;
                }
            }
        }
        $items[] = ['port' => $port, 'address' => (string) $parts[3], 'siteOwned' => $siteOwned, 'process' => $process];
    }
    return $items;
}

function isSafeEndpointAddress(string $address, int $port): bool
{
    return $address === '127.0.0.1:' . $port
        || $address === '[::1]:' . $port
        || $address === '::1:' . $port;
}

// A project endpoint may expose only a listener demonstrably owned by the
// parent site's Unix boundary. Wildcard/public listeners and foreign
// loopback processes are never eligible for an NGINX reverse proxy.
function manageSiteEndpoint($manager, Site $site, array $operation): array
{
    $action = $operation['action'] ?? null;
    if (!in_array($action, ['list', 'verify'], true)) invalidBrokerRequest();
    $listeners = hostListeningPorts($site);
    $owned = array_values(array_map(
        static fn(array $item): array => [
            'port' => (int) $item['port'],
            'address' => (string) $item['address'],
            'process' => (string) $item['process'],
        ],
        array_filter(
            $listeners,
            static fn(array $item): bool => !empty($item['siteOwned'])
                && isSafeEndpointAddress((string) $item['address'], (int) $item['port'])
                && (int) $item['port'] >= 1024,
        ),
    ));
    usort($owned, static fn(array $left, array $right): int => $left['port'] <=> $right['port']);
    $result = ['ports' => $owned, 'checkedAt' => gmdate(DATE_ATOM)];
    if ($action === 'list') return $result;

    $port = brokerPortValue($operation['port'] ?? null);
    $endpointDomain = isset($operation['endpointDomain'])
        ? brokerDomainValue($operation['endpointDomain'])
        : null;
    foreach ($manager->getRepository(Site::class)->findAll() as $candidate) {
        if (!$candidate instanceof Site || $candidate->getId() === $site->getId()) continue;
        if ($endpointDomain !== null && strtolower($candidate->getDomainName()) === $endpointDomain) continue;
        if (expectedSitePort($candidate) === $port) {
            return $result + ['probe' => [
                'port' => $port,
                'owned' => false,
                'loopback' => false,
                'reachable' => false,
                'detail' => 'Port ' . $port . ' is reserved by another CloudPanel website.',
            ]];
        }
    }
    $matching = array_values(array_filter(
        $listeners,
        static fn(array $item): bool => (int) $item['port'] === $port,
    ));
    $eligible = array_values(array_filter(
        $matching,
        static fn(array $item): bool => !empty($item['siteOwned'])
            && isSafeEndpointAddress((string) $item['address'], $port),
    ));
    if (!$eligible) {
        $detail = $matching
            ? 'Port ' . $port . ' is listening, but it is not a loopback listener owned by this project.'
            : 'Port ' . $port . ' is not listening yet.';
        return $result + ['probe' => [
            'port' => $port,
            'owned' => false,
            'loopback' => false,
            'reachable' => false,
            'detail' => $detail,
        ]];
    }

    $curl = is_executable('/usr/bin/curl') ? '/usr/bin/curl' : findSiteTool('/home/' . $site->getUser(), 'curl');
    if (!$curl) return $result + ['probe' => [
        'port' => $port,
        'owned' => true,
        'loopback' => true,
        'reachable' => false,
        'detail' => 'The port belongs to this project, but curl is unavailable for the health check.',
    ]];
    $probe = runSiteCommand(
        $site,
        [$curl, '--silent', '--show-error', '--output', '/dev/null', '--max-time', '10', '--write-out', '%{http_code}', 'http://127.0.0.1:' . $port . '/'],
        15,
    );
    $status = preg_match('/^\d{3}$/', trim((string) $probe['stdout'])) === 1
        ? (int) trim((string) $probe['stdout'])
        : 0;
    $healthy = $probe['code'] === 0 && $status >= 100 && $status < 500;
    return $result + ['probe' => array_filter([
        'port' => $port,
        'owned' => true,
        'loopback' => true,
        'reachable' => $healthy,
        'httpStatus' => $status ?: null,
        'detail' => $healthy
            ? 'The project-owned loopback endpoint responded with HTTP ' . $status . '.'
            : 'The project owns this loopback port, but its HTTP health check failed.',
    ], static fn($value) => $value !== null)];
}

function sitePortCapability(Site $site, array $listeners): array
{
    $expected = expectedSitePort($site);
    $sitePorts = array_values(array_unique(array_map(
        static fn(array $item): int => (int) $item['port'],
        array_filter($listeners, static fn(array $item): bool => !empty($item['siteOwned'])),
    )));
    sort($sitePorts);
    $matching = $expected === null ? [] : array_values(array_filter(
        $listeners,
        static fn(array $item): bool => (int) $item['port'] === $expected,
    ));
    $owned = array_values(array_filter(
        $matching,
        static fn(array $item): bool => !empty($item['siteOwned'])
            && isSafeEndpointAddress((string) $item['address'], (int) $item['port']),
    ));
    $occupied = count($matching) > 0;
    $listening = count($owned) > 0;
    $conflict = $occupied && !$listening;
    if ($expected === null) $detail = 'This CloudPanel site is served directly and has no application upstream port.';
    elseif ($listening) $detail = "This site's process owns the configured loopback upstream port $expected.";
    elseif ($conflict) $detail = "CloudPanel expects port $expected, but another website or system process already owns it.";
    elseif ($sitePorts) $detail = 'CloudPanel expects port ' . $expected . ', but site-owned processes currently listen on ' . implode(', ', $sitePorts) . '.';
    else $detail = "CloudPanel expects port $expected, but no process is listening there yet.";
    return [
        'expected' => $expected,
        'listening' => $listening,
        'occupied' => $occupied,
        'owned' => $listening,
        'conflict' => $conflict,
        'detected' => $sitePorts,
        'detail' => $detail,
    ];
}

function composeLabels(array $service): array
{
    $labels = $service['labels'] ?? [];
    if (!is_array($labels)) return [];
    $normalized = [];
    foreach ($labels as $key => $value) {
        if (is_int($key) && is_string($value) && str_contains($value, '=')) {
            [$key, $value] = explode('=', $value, 2);
        }
        if (is_string($key)) $normalized[strtolower($key)] = is_scalar($value) ? (string) $value : '';
    }
    return $normalized;
}

function composeServicePorts(array $service): array
{
    $targets = [];
    $published = [];
    foreach ((array) ($service['ports'] ?? []) as $port) {
        if (!is_array($port)) continue;
        $target = (int) ($port['target'] ?? 0);
        if ($target < 1 || $target > 65535) continue;
        $targets[] = $target;
        $hostPort = (int) ($port['published'] ?? 0);
        if ($hostPort >= 1 && $hostPort <= 65535) {
            $published[] = [
                'containerPort' => $target,
                'publishedPort' => $hostPort,
                'hostIp' => (string) ($port['host_ip'] ?? ''),
            ];
        }
    }
    foreach ((array) ($service['expose'] ?? []) as $value) {
        if (preg_match('/^(\d{1,5})/', (string) $value, $match)) $targets[] = (int) $match[1];
    }
    $environment = $service['environment'] ?? [];
    if (is_array($environment)) {
        foreach (['PORT', 'APP_PORT', 'HTTP_PORT'] as $key) {
            $value = $environment[$key] ?? null;
            if (is_numeric($value) && (int) $value >= 1 && (int) $value <= 65535) $targets[] = (int) $value;
        }
    }
    $health = $service['healthcheck']['test'] ?? [];
    $healthText = is_array($health) ? implode(' ', array_map('strval', $health)) : (string) $health;
    if (preg_match_all('#https?://(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})#i', $healthText, $matches)) {
        foreach ($matches[1] as $value) $targets[] = (int) $value;
    }
    $targets = array_values(array_unique(array_filter($targets, static fn(int $port): bool => $port >= 1 && $port <= 65535)));
    return ['targets' => $targets, 'published' => $published];
}

// Select the one service that represents this CloudPanel site's public entry
// point. Explicit labels win. Otherwise use an already-correct publication,
// a single candidate, the Compose dependency graph, then conventional gateway
// names. Ambiguity is a blocker rather than a guess.
function composePortRouting(?int $expected, array $config): array
{
    $candidates = [];
    $allPublished = [];
    $dependedOn = [];
    $explicit = [];
    foreach ((array) ($config['services'] ?? []) as $name => $service) {
        if (!is_array($service)) continue;
        $ports = composeServicePorts($service);
        if ($ports['targets']) $candidates[(string) $name] = ['service' => (string) $name] + $ports;
        foreach ($ports['published'] as $port) $allPublished[] = ['service' => (string) $name] + $port;
        foreach (array_keys((array) ($service['depends_on'] ?? [])) as $dependency) $dependedOn[(string) $dependency] = true;
        $labels = composeLabels($service);
        if (in_array(strtolower($labels['io.panelavo.entrypoint'] ?? $labels['panelavo.entrypoint'] ?? ''), ['1', 'true', 'yes'], true)) {
            $explicit[] = (string) $name;
        }
        $labelPort = $labels['io.panelavo.container-port'] ?? $labels['panelavo.container-port'] ?? null;
        if (isset($candidates[(string) $name]) && is_numeric($labelPort)) $candidates[(string) $name]['labelPort'] = (int) $labelPort;
    }

    $selected = null;
    if ($expected !== null) {
        $matches = array_values(array_filter($allPublished, static fn(array $item): bool => (int) $item['publishedPort'] === $expected));
        if (count($matches) === 1) $selected = $matches[0]['service'];
    }
    if ($selected === null && count($explicit) === 1 && isset($candidates[$explicit[0]])) $selected = $explicit[0];
    if ($selected === null && count($candidates) === 1) $selected = array_key_first($candidates);
    if ($selected === null && $candidates) {
        $roots = array_values(array_filter(array_keys($candidates), static fn(string $name): bool => !isset($dependedOn[$name])));
        if (count($roots) === 1) $selected = $roots[0];
    }
    if ($selected === null && $candidates) {
        $rank = ['frontend' => 100, 'web' => 90, 'gateway' => 80, 'proxy' => 70, 'nginx' => 60, 'app' => 50];
        $scores = [];
        foreach (array_keys($candidates) as $name) {
            $lower = strtolower($name);
            foreach ($rank as $needle => $score) {
                if ($lower === $needle || str_contains($lower, $needle)) { $scores[$name] = max($scores[$name] ?? 0, $score); break; }
            }
        }
        if ($scores) {
            arsort($scores);
            $top = (int) reset($scores);
            $leaders = array_keys(array_filter($scores, static fn(int $score): bool => $score === $top));
            if (count($leaders) === 1) $selected = $leaders[0];
        }
    }

    $containerPort = null;
    $publishedPort = null;
    if ($selected !== null) {
        $candidate = $candidates[$selected];
        if (!empty($candidate['labelPort']) && in_array($candidate['labelPort'], $candidate['targets'], true)) {
            $containerPort = (int) $candidate['labelPort'];
        } else {
            $matchingPublished = $expected === null ? [] : array_values(array_filter(
                $candidate['published'],
                static fn(array $item): bool => (int) $item['publishedPort'] === $expected,
            ));
            if (count($matchingPublished) === 1) $containerPort = (int) $matchingPublished[0]['containerPort'];
            elseif (count($candidate['targets']) === 1) $containerPort = (int) $candidate['targets'][0];
            else {
                $environmentPort = null;
                $service = $config['services'][$selected] ?? [];
                foreach (['PORT', 'APP_PORT', 'HTTP_PORT'] as $key) {
                    $value = is_array($service['environment'] ?? null) ? ($service['environment'][$key] ?? null) : null;
                    if (is_numeric($value) && in_array((int) $value, $candidate['targets'], true)) { $environmentPort = (int) $value; break; }
                }
                if ($environmentPort !== null) $containerPort = $environmentPort;
            }
        }
        if ($containerPort !== null) {
            foreach ($candidate['published'] as $port) {
                if ((int) $port['containerPort'] === $containerPort) { $publishedPort = (int) $port['publishedPort']; break; }
            }
        }
    }
    $portMatches = $expected !== null && $containerPort !== null && count(array_filter(
        $allPublished,
        static fn(array $item): bool => $item['service'] === $selected
            && (int) $item['containerPort'] === $containerPort
            && (int) $item['publishedPort'] === $expected
            && in_array((string) ($item['hostIp'] ?? ''), ['127.0.0.1', '::1', 'localhost'], true),
    )) > 0;
    $canAutoRemap = $expected !== null && $selected !== null && $containerPort !== null && !$portMatches;
    $additional = array_values(array_filter($allPublished, static fn(array $item): bool => !(
        $item['service'] === $selected && (int) $item['containerPort'] === $containerPort
    )));
    if ($expected === null) $detail = 'CloudPanel has no local reverse-proxy port configured for this project.';
    elseif ($selected === null) $detail = 'CloudPanel expects port ' . $expected . ', but the Compose entry service is ambiguous. Add label io.panelavo.entrypoint=true to exactly one service.';
    elseif ($containerPort === null) $detail = 'Entry service "' . $selected . '" was detected, but its container port is ambiguous. Add label io.panelavo.container-port=<port>.';
    elseif ($portMatches) $detail = 'Entry service "' . $selected . '" maps container port ' . $containerPort . ' to 127.0.0.1:' . $expected . ', matching CloudPanel.';
    else $detail = 'Entry service "' . $selected . '" currently uses host port ' . ($publishedPort ?: 'none') . '; deployment will map container port ' . $containerPort . ' to 127.0.0.1:' . $expected . ' for CloudPanel.';
    return [
        'expectedPort' => $expected,
        'entryService' => $selected,
        'containerPort' => $containerPort,
        'publishedPort' => $publishedPort,
        'portMatches' => $portMatches,
        'canAutoRemap' => $canAutoRemap,
        'portDetail' => $detail,
        'additionalPorts' => $additional,
    ];
}

function remapResolvedCompose(array $config, array $routing): array
{
    // Compose versions emit either `ipam: null` or `ipam: {}` for networks
    // without custom IPAM settings. Associative json_decode() turns the empty
    // object into [], which Compose rejects when the resolved JSON is loaded
    // again because ipam must be a mapping. Drop both synthetic empty shapes
    // while preserving every non-empty operator-defined IPAM mapping.
    foreach ((array) ($config['networks'] ?? []) as $name => $network) {
        if (is_array($network) && array_key_exists('ipam', $network)
            && ($network['ipam'] === null || $network['ipam'] === [])) {
            unset($config['networks'][$name]['ipam']);
        }
    }
    // Long-syntax mounts carry option sub-keys (`volume`, `bind`, `tmpfs`,
    // `cluster`) that Compose emits as empty objects when no options are set —
    // e.g. a named volume `postgres-data:/data` resolves to
    // `{type: volume, source, target, volume: {}}`. Associative json_decode()
    // collapses `{}` to [], and reloading the resolved JSON then fails with
    // "volumes.N.volume must be a mapping". Drop the synthetic empty sub-keys
    // (absent means the same defaults) while preserving any real options.
    foreach ((array) ($config['services'] ?? []) as $name => $service) {
        if (!is_array($service) || !isset($service['volumes']) || !is_array($service['volumes'])) continue;
        foreach ($service['volumes'] as $index => $mount) {
            if (!is_array($mount)) continue;
            foreach (['volume', 'bind', 'tmpfs', 'cluster'] as $option) {
                if (array_key_exists($option, $mount) && $mount[$option] === []) {
                    unset($config['services'][$name]['volumes'][$index][$option]);
                }
            }
        }
    }
    // Rootful Compose is always forced onto loopback at runtime, including
    // secondary service ports. The source file remains untouched.
    foreach ((array) ($config['services'] ?? []) as $name => $service) {
        if (!is_array($service)) continue;
        foreach ((array) ($service['ports'] ?? []) as $index => $port) {
            if (is_array($port) && isset($port['published'])) {
                $config['services'][$name]['ports'][$index]['host_ip'] = '127.0.0.1';
            }
        }
    }
    if (empty($routing['canAutoRemap'])) return $config;
    $service = (string) $routing['entryService'];
    $target = (int) $routing['containerPort'];
    $expected = (int) $routing['expectedPort'];
    if (!isset($config['services'][$service]) || !is_array($config['services'][$service])) return $config;
    $ports = array_values(array_filter(
        (array) ($config['services'][$service]['ports'] ?? []),
        static fn($port): bool => !is_array($port) || (int) ($port['target'] ?? 0) !== $target,
    ));
    $ports[] = ['mode' => 'ingress', 'target' => $target, 'published' => (string) $expected, 'protocol' => 'tcp', 'host_ip' => '127.0.0.1'];
    $config['services'][$service]['ports'] = $ports;
    return $config;
}

// Host-safety policy for rootful Compose: everything the project touches must
// stay inside the site root, published ports must bind to loopback only, and
// no privilege- or namespace-escalating feature is accepted. All violations
// are collected so Panelavo can tell the difference between a project whose
// only problem is public port bindings (which it can safely rewrite to
// loopback) and one that also uses a feature only the operator can resolve.
// Warnings are advisory only.
function composeSafetyScan(array $config, string $root): array
{
    $warnings = [];
    $portViolation = null;
    $otherViolation = null;
    $inRoot = static function ($path) use ($root): bool {
        return is_string($path) && $path !== '' && pathIsContained($path, $root);
    };
    $other = static function (string $detail) use (&$otherViolation): void {
        $otherViolation ??= $detail;
    };
    foreach (($config['services'] ?? []) as $name => $service) {
        if (!is_array($service)) continue;
        if (!empty($service['privileged'])) $other("Service \"$name\" requests privileged mode.");
        if (!empty($service['cap_add'])) $other("Service \"$name\" adds Linux capabilities.");
        if (!empty($service['devices'])) $other("Service \"$name\" maps host devices.");
        if (!empty($service['sysctls'])) $other("Service \"$name\" sets host sysctls.");
        foreach (['network_mode', 'pid', 'ipc', 'userns_mode', 'cgroup'] as $key) {
            $value = $service[$key] ?? null;
            if (is_string($value) && ($value === 'host' || str_starts_with($value, 'container:') || str_starts_with($value, 'service:'))) {
                $other("Service \"$name\" shares the host or another container's $key namespace.");
            }
        }
        foreach ((array) ($service['security_opt'] ?? []) as $option) {
            if (!is_string($option) || !str_starts_with($option, 'no-new-privileges')) {
                $other("Service \"$name\" sets a security option Panelavo will not run as root.");
            }
        }
        foreach ((array) ($service['ports'] ?? []) as $port) {
            $hostIp = is_array($port) ? (string) ($port['host_ip'] ?? '') : '';
            $published = is_array($port) ? ($port['published'] ?? null) : $port;
            if ($published === null || $published === '') continue;
            if (!in_array($hostIp, ['127.0.0.1', '::1', 'localhost'], true)) {
                $portViolation ??= "Service \"$name\" publishes a port without binding it to 127.0.0.1.";
            }
        }
        foreach ((array) ($service['volumes'] ?? []) as $volume) {
            if (is_array($volume) && ($volume['type'] ?? '') === 'bind' && !$inRoot($volume['source'] ?? '')) {
                $other("Service \"$name\" bind-mounts a path outside the website root.");
            }
        }
        $build = $service['build'] ?? null;
        $context = is_array($build) ? ($build['context'] ?? '') : (is_string($build) ? $build : null);
        if ($context !== null && $context !== '' && !$inRoot($context)) {
            $other("Service \"$name\" builds from a context outside the website root.");
        }
        if (empty($service['restart'])) {
            $warnings[] = "Service \"$name\" declares no restart policy; it will not come back after a host reboot.";
        }
    }
    foreach (['secrets', 'configs'] as $section) {
        foreach ((array) ($config[$section] ?? []) as $name => $entry) {
            if (is_array($entry) && isset($entry['file']) && !$inRoot($entry['file'])) {
                $other(ucfirst($section) . " entry \"$name\" reads a file outside the website root.");
            }
        }
    }
    // A non-fixable violation is reported first so the operator sees the
    // blocker the port rewrite will not resolve; port-only projects surface
    // the port message together with the one-click fix.
    $detail = $otherViolation ?? $portViolation;
    return [
        'safe' => $detail === null,
        'detail' => $detail,
        'warnings' => $warnings,
        'portFixable' => $portViolation !== null && $otherViolation === null,
    ];
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
    $rootless = rootlessCapability($site);
    $capability = [
        'file' => $file,
        'expectedPort' => expectedSitePort($site),
        'cliAvailable' => $cli !== null,
        'pluginAvailable' => false,
        'daemonAvailable' => false,
        'engineMode' => 'rootless',
        'rootless' => $rootless,
        'warnings' => [],
    ];
    if (!$file || !$cli) return $capability;
    $version = runRootlessDockerCommand($site, ['docker', 'compose', 'version', '--short'], 15);
    if ($version['code'] !== 0) return $capability;
    $capability['pluginAvailable'] = true;
    $capability['version'] = trim($version['stdout']);
    $capability['daemonAvailable'] = !empty($rootless['ready']);
    $config = runRootlessDockerCommand($site, ['docker', 'compose', '-f', $file, '-p', composeProjectName($site), 'config', '--format', 'json'], 60);
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
    $routing = composePortRouting(expectedSitePort($site), $parsed);
    $capability = array_merge($capability, $routing);
    $sourceSafety = composeSafetyScan($parsed, $root);
    $runtimeConfig = remapResolvedCompose($parsed, $routing);
    $runtimeSafety = composeSafetyScan($runtimeConfig, $root);
    $capability['safe'] = $runtimeSafety['safe'];
    if (!$runtimeSafety['safe']) $capability['detail'] = $runtimeSafety['detail'];
    $capability['portFixable'] = false;
    $capability['runtimeOverride'] = $runtimeConfig !== $parsed;
    $capability['warnings'] = array_values(array_unique(array_merge($sourceSafety['warnings'], $runtimeSafety['warnings'])));
    if (!$sourceSafety['safe'] && $sourceSafety['portFixable'] && $runtimeSafety['safe']) {
        $capability['warnings'][] = 'Published Compose ports will be restricted to 127.0.0.1 in Panelavo\'s ephemeral runtime model; the source Compose file is not edited.';
    }
    if (!empty($routing['additionalPorts'])) {
        $summary = implode(', ', array_map(
            static fn(array $port): string => $port['service'] . ':' . $port['containerPort'] . ' on ' . (($port['hostIp'] ?? '') !== '' ? $port['hostIp'] : '*') . ':' . $port['publishedPort'],
            $routing['additionalPorts'],
        ));
        $capability['warnings'][] = 'Additional loopback service ports were detected (' . $summary . '). Create a connected reverse-proxy site for each additional public service endpoint.';
    }
    // Internal only: Operations uses this resolved model to apply an ephemeral
    // port mapping. actionsSection() removes it before any browser response.
    $capability['_runtimeConfig'] = $runtimeConfig;
    return $capability;
}

function textMentionsPort(string $text, int $port): bool
{
    return preg_match('/(?<!\d)' . preg_quote((string) $port, '/') . '(?!\d)/', $text) === 1;
}

function directPortSourceHints(string $root, int $port, ?array $package, ?string $ecosystem): array
{
    $hints = [];
    foreach (['.env', '.env.local', '.env.production'] as $name) {
        $path = $root . '/' . $name;
        $content = !is_link($path) && is_file($path) && filesize($path) <= 262144 ? (string) @file_get_contents($path) : '';
        if ($content !== '' && preg_match('/^\s*(?:export\s+)?PORT\s*=/mi', $content)) {
            $hints[] = $name . ' PORT';
        }
    }
    if ($ecosystem) {
        $ecosystemPath = $root . '/' . $ecosystem;
        $content = !is_link($ecosystemPath) && is_file($ecosystemPath)
            ? (string) @file_get_contents($ecosystemPath, false, null, 0, 262144)
            : '';
        if (preg_match('/\bPORT\b\s*[:=]/i', $content)) {
            $hints[] = $ecosystem . ' PORT';
        }
    }
    foreach (($package['scripts'] ?? []) as $command) {
        if (is_string($command) && preg_match('/(?:^|\s)(?:--port(?:=|\s)|-p(?:=|\s)|PORT\s*=)/i', $command)) {
            $hints[] = 'package.json script';
            break;
        }
    }
    foreach (array_merge(['Dockerfile'], glob($root . '/Dockerfile.*') ?: []) as $candidate) {
        $path = str_starts_with($candidate, '/') ? $candidate : $root . '/' . $candidate;
        if (!is_link($path) && is_file($path) && filesize($path) <= 262144 && textMentionsPort((string) @file_get_contents($path), $port)) {
            $hints[] = basename($path);
        }
    }
    return array_values(array_unique($hints));
}

function portRepairCapability(
    Site $site,
    string $root,
    array $port,
    ?string $composeFile,
    ?array $compose,
    ?array $package,
    ?string $ecosystem,
): array {
    $expected = isset($port['expected']) && is_numeric($port['expected']) ? (int) $port['expected'] : null;
    if (!$expected) return ['canApply' => false, 'detail' => 'This website has no configurable local application port.'];

    if ($composeFile !== null) {
        if (!is_array($compose) || ($compose['configValid'] ?? false) !== true) {
            return ['canApply' => false, 'expectedPort' => $expected, 'file' => $composeFile,
                'detail' => 'Validate the Compose configuration first; Panelavo will not edit an unresolved port mapping.'];
        }
        if (!empty($compose['portMatches'])) {
            return ['canApply' => false, 'expectedPort' => $expected, 'file' => $composeFile,
                'detail' => 'The Compose source already publishes the CloudPanel port on loopback.'];
        }
        if (($compose['safe'] ?? false) !== true) {
            return ['canApply' => false, 'expectedPort' => $expected, 'file' => $composeFile,
                'detail' => 'Resolve the reported Compose host-safety violation before changing its port mapping. Panelavo will not partially rewrite an unsafe project.'];
        }
        $service = (string) ($compose['entryService'] ?? '');
        $container = (int) ($compose['containerPort'] ?? 0);
        $published = (int) ($compose['publishedPort'] ?? 0);
        $source = !is_link($root . '/' . $composeFile) && is_file($root . '/' . $composeFile) && filesize($root . '/' . $composeFile) <= 1048576
            ? (string) @file_get_contents($root . '/' . $composeFile)
            : '';
        $loopback = $source !== '' ? rewriteComposePorts($source) : '';
        $rewritten = $loopback !== '' && $service !== '' && $container > 0 && $published > 0
            ? rewriteComposeEntryPort($loopback, $published, $container, $expected)
            : null;
        if (!empty($compose['canAutoRemap']) && is_string($rewritten) && $rewritten !== $source) {
            return [
                'canApply' => true,
                'kind' => 'compose',
                'expectedPort' => $expected,
                'detectedPort' => $published,
                'containerPort' => $container,
                'file' => $composeFile,
                'detail' => 'Panelavo can update ' . $composeFile . ' so entry service "' . $service . '" publishes container port ' . $container . ' privately as 127.0.0.1:' . $expected . '. Dockerfile EXPOSE and the in-container port remain ' . $container . '.',
            ];
        }
        $instruction = $service !== '' && $container > 0
            ? 'In ' . $composeFile . ', set entry service "' . $service . '" to `127.0.0.1:' . $expected . ':' . $container . '`. Keep Dockerfile EXPOSE and the in-container PORT at ' . $container . '.'
            : 'Label exactly one service `io.panelavo.entrypoint=true` and, if needed, `io.panelavo.container-port=<port>`, then map it to `127.0.0.1:' . $expected . ':<container-port>`.';
        return ['canApply' => false, 'expectedPort' => $expected, 'detectedPort' => $published ?: null, 'file' => $composeFile,
            'detail' => $instruction . ' Panelavo found no single literal short mapping it could change without guessing, so it made no source edit.'];
    }

    if (!in_array($site->getType(), [Site::TYPE_NODEJS, Site::TYPE_PYTHON], true)) {
        return ['canApply' => false, 'expectedPort' => $expected,
            'detail' => 'Start the application on 127.0.0.1:' . $expected . ' or update the website upstream in Settings.'];
    }
    if (!empty($port['listening'])) {
        return ['canApply' => false, 'expectedPort' => $expected,
            'detail' => 'The application is already listening on the CloudPanel port.'];
    }

    $envPath = $root . '/.env';
    $source = !is_link($envPath) && is_file($envPath) && filesize($envPath) <= 262144 ? (string) @file_get_contents($envPath) : '';
    $dotenv = $source !== '' ? rewriteDotenvPort($source, $expected) : null;
    $from = is_array($dotenv) ? (int) $dotenv['from'] : 0;
    $hints = $from > 0 ? directPortSourceHints($root, $from, $package, $ecosystem) : [];
    $blockingHints = array_values(array_filter($hints, static fn(string $hint): bool => $hint !== '.env PORT' && !str_starts_with($hint, 'Dockerfile')));
    $detected = array_values(array_filter((array) ($port['detected'] ?? []), 'is_numeric'));
    $listenerMatches = !$detected || (count($detected) === 1 && (int) $detected[0] === $from);
    if (is_array($dotenv) && $from !== $expected && !$blockingHints && $listenerMatches) {
        return [
            'canApply' => true,
            'kind' => 'dotenv',
            'expectedPort' => $expected,
            'detectedPort' => $from,
            'file' => '.env',
            'detail' => 'Panelavo can update the one unambiguous .env PORT assignment from ' . $from . ' to ' . $expected . '. The application must read PORT; restart it after the edit.',
        ];
    }
    $observed = $hints ?: array_map(static fn($value): string => 'listener ' . (int) $value, $detected);
    $where = $observed ? ' Detected: ' . implode(', ', $observed) . '.' : '';
    return [
        'canApply' => false,
        'expectedPort' => $expected,
        'detectedPort' => $from ?: (isset($detected[0]) ? (int) $detected[0] : null),
        'file' => !is_link($envPath) && is_file($envPath) ? '.env' : null,
        'detail' => 'Set `PORT=' . $expected . '` in .env, remove any hard-coded `--port`/`-p` or ecosystem PORT override, and make the application read PORT before restarting it.' . $where . ' Panelavo found more than one possible authority or no unique editable setting, so it made no change.',
    ];
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
    $composeFile = findComposeFile($root);
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
    $listeners = hostListeningPorts($site);
    $port = sitePortCapability($site, $listeners);
    $compose = $composeFile !== null ? composeCapability($site, $root, $composeFile) : null;
    $portRepair = portRepairCapability($site, $root, $port, $composeFile, $compose, $package, $ecosystem);
    return [
        'type' => $site->getType(),
        'path' => $root,
        'framework' => detectFramework($root, $package),
        'processName' => preg_replace('/[^a-zA-Z0-9._-]/', '-', $site->getDomainName()),
        'reverseProxyUrl' => $site->getReverseProxyUrl(),
        'expectedPort' => $port['expected'],
        'port' => $port,
        'portRepair' => $portRepair,
        'listeners' => array_values(array_map(
            static fn(array $item): array => ['port' => (int) $item['port'], 'address' => (string) $item['address'], 'process' => (string) $item['process']],
            array_filter($listeners, static fn(array $item): bool => !empty($item['siteOwned'])),
        )),
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
        'compose' => $compose,
        'permissions' => [
            'manage' => in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true),
            'docker' => $user->getRole() === User::ROLE_ADMIN,
            'hostAdmin' => $user->getRole() === User::ROLE_ADMIN,
        ],
        '_rootlessEnv' => rootlessDockerEnvironment($site),
        'ecosystemFile' => $ecosystem,
        'venvPython' => $venvPython,
        'composeProject' => composeProjectName($site),
        'pm2Available' => $tools['pm2']['available'],
        'dockerAvailable' => $tools['docker']['available'],
    ];
}

// Compares the site's configured .env against the environment a running
// process actually has. Only key names and a sync verdict leave the bridge —
// values never reach the browser through the Operations payload.
function envDriftForRunning(array $configured, array $runningSets): array
{
    $keys = [];
    foreach (array_slice(array_keys($configured), 0, 50) as $key) {
        $status = 'unknown';
        foreach ($runningSets as $running) {
            if (!array_key_exists($key, $running)) { $status = 'missing'; break; }
            $status = (string) $running[$key] === (string) $configured[$key]
                ? ($status === 'unknown' ? 'match' : $status)
                : 'differs';
            if ($status === 'differs') break;
        }
        $keys[] = ['key' => (string) $key, 'status' => $status];
    }
    return $keys;
}

function actionsSection(Site $site, User $user): array
{
    $state = operationsState($site, $user);
    $dotenvPath = $state['path'] . '/.env';
    $dotenv = is_file($dotenvPath) && filesize($dotenvPath) <= 262144
        ? parseEnvContent((string) @file_get_contents($dotenvPath))
        : [];
    $runningEnvSets = [];

    $processes = [];
    if ($state['pm2Available'] && is_dir($state['path'])) {
        $pm2 = runSiteCommand($site, ['pm2', 'jlist'], 20);
        $start = strpos($pm2['stdout'], '[');
        $list = $start === false ? null : json_decode(substr($pm2['stdout'], $start), true);
        foreach (is_array($list) ? $list : [] as $proc) {
            if (!is_array($proc)) continue;
            $env = is_array($proc['pm2_env'] ?? null) ? $proc['pm2_env'] : [];
            $status = (string) ($env['status'] ?? 'unknown');
            $uptimeMs = is_numeric($env['pm_uptime'] ?? null) ? (int) $env['pm_uptime'] : 0;
            $processes[] = [
                'name' => (string) ($proc['name'] ?? ''),
                'status' => $status,
                'cpu' => (float) ($proc['monit']['cpu'] ?? 0),
                'memory' => (int) ($proc['monit']['memory'] ?? 0),
                'restarts' => (int) ($env['restart_time'] ?? 0),
                'pid' => (int) ($proc['pid'] ?? 0),
                'uptimeSeconds' => $status === 'online' && $uptimeMs > 0
                    ? max(0, (int) round((microtime(true) * 1000 - $uptimeMs) / 1000))
                    : 0,
            ];
            // pm2 jlist merges the spawn-time environment into pm2_env, so the
            // configured keys can be checked for drift against the live process.
            if ($status === 'online' && $dotenv) {
                $running = [];
                foreach (array_keys($dotenv) as $key) {
                    if (array_key_exists($key, $env) && is_scalar($env[$key])) $running[$key] = (string) $env[$key];
                }
                $runningEnvSets[] = $running;
            }
        }
    }

    // Live Docker Compose state for this site's project: container status,
    // health, and published ports, plus the entry service's real environment.
    $containers = [];
    $compose = $state['compose'] ?? null;
    if (is_array($compose) && !empty($compose['daemonAvailable']) && !empty($compose['pluginAvailable']) && !empty($compose['file'])) {
        $ps = runRootlessDockerCommand($site, ['docker', 'compose', '-f', $compose['file'], '-p', $state['composeProject'], 'ps', '-a', '--format', 'json'], 20);
        if ($ps['code'] === 0) {
            $rows = json_decode(trim($ps['stdout']), true);
            if (!is_array($rows) || array_is_list($rows) === false) {
                $rows = [];
                foreach (preg_split('/\R/', trim($ps['stdout'])) ?: [] as $line) {
                    $row = json_decode($line, true);
                    if (is_array($row)) $rows[] = $row;
                }
            }
            $entryContainerId = null;
            foreach ($rows as $row) {
                if (!is_array($row)) continue;
                $ports = [];
                foreach ((array) ($row['Publishers'] ?? []) as $publisher) {
                    if (!is_array($publisher) || empty($publisher['PublishedPort'])) continue;
                    $ports[] = (($publisher['URL'] ?? '') !== '' ? $publisher['URL'] . ':' : '')
                        . $publisher['PublishedPort'] . '→' . ($publisher['TargetPort'] ?? '?');
                }
                $containers[] = [
                    'name' => (string) ($row['Name'] ?? ''),
                    'service' => (string) ($row['Service'] ?? ''),
                    'state' => (string) ($row['State'] ?? 'unknown'),
                    'health' => (string) ($row['Health'] ?? ''),
                    'status' => (string) ($row['Status'] ?? ''),
                    'ports' => array_values(array_unique($ports)),
                ];
                if (($row['Service'] ?? null) === ($compose['entryService'] ?? '') && ($row['State'] ?? '') === 'running') {
                    $entryContainerId = (string) ($row['ID'] ?? '');
                }
            }
            if ($dotenv && $entryContainerId !== null && preg_match('/^[0-9a-f]{12,64}$/i', $entryContainerId)) {
                $inspect = runRootlessDockerCommand($site, ['docker', 'inspect', '--format', '{{json .Config.Env}}', $entryContainerId], 15);
                $containerEnv = $inspect['code'] === 0 ? json_decode(trim($inspect['stdout']), true) : null;
                if (is_array($containerEnv)) {
                    $running = [];
                    foreach ($containerEnv as $pair) {
                        if (is_string($pair) && ($eq = strpos($pair, '=')) !== false) $running[substr($pair, 0, $eq)] = substr($pair, $eq + 1);
                    }
                    $runningEnvSets[] = $running;
                }
            }
        }
    }

    $runtime = [
        'containers' => $containers,
        'listeners' => $state['listeners'],
        'envFile' => is_file($dotenvPath) ? '.env' : null,
        'env' => $runningEnvSets ? envDriftForRunning($dotenv, $runningEnvSets) : [],
        'checkedAt' => gmdate(DATE_ATOM),
    ];
    if (is_array($state['compose'] ?? null)) $state['migration'] = migrationStatus($site, $state['compose']);
    unset($state['ecosystemFile'], $state['venvPython'], $state['composeProject'], $state['_rootlessEnv']);
    if (is_array($state['compose'] ?? null)) unset($state['compose']['_runtimeConfig']);
    return $state + ['pm2' => $processes, 'runtime' => $runtime];
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

    // PM2 launches receive the site's .env variables plus CloudPanel's
    // expected port, so the live process environment matches the configured
    // one even when the application never parses .env itself. CloudPanel's
    // port always wins over a conflicting .env PORT.
    $portEnv = !empty($state['expectedPort'])
        ? ['PORT' => (string) $state['expectedPort'], 'HOST' => '127.0.0.1', 'HOSTNAME' => '127.0.0.1']
        : [];
    $withRuntimeEnv = static function (array $definition) use ($root, $portEnv): array {
        $env = array_merge(dotenvOperationEnv($root), $portEnv);
        if ($env) $definition['env'] = $env;
        return $definition;
    };
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
        if (in_array($command, ['compose-up', 'compose-deploy'], true)) {
            $require(!empty($compose['portMatches']) || !empty($compose['canAutoRemap']));
            $require(empty($state['port']['conflict']), 'PORT_IN_USE');
        }
        $mapped = !empty($compose['runtimeOverride']) && is_array($compose['_runtimeConfig'] ?? null);
        return [
            'command' => $command,
            'label' => $label,
            'args' => array_merge(['docker', 'compose', '-f', $mapped ? '@PANELAVO_COMPOSE_CONFIG@' : $compose['file'], '-p', $state['composeProject']], $verb),
            'timeout' => $timeout,
            'asRoot' => false,
            'env' => $state['_rootlessEnv'],
        ] + ($mapped ? ['composeConfig' => $compose['_runtimeConfig']] : []);
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
        case 'compose-port-verify':
        case 'runtime-port-verify':
            $expected = (int) ($state['expectedPort'] ?? 0);
            $require($expected >= 1 && $expected <= 65535);
            $require($available('curl'), 'TOOL_UNAVAILABLE');
            return $step(
                'Verify configured upstream port',
                ['curl', '--silent', '--show-error', '--output', '/dev/null', '--retry', '12', '--retry-delay', '5', '--retry-all-errors', '--connect-timeout', '3', '--max-time', '90', '--write-out', 'HTTP %{http_code} from 127.0.0.1:' . $expected . "\n", 'http://127.0.0.1:' . $expected . '/'],
                120,
            ) + ['verifyOwnedPort' => $expected];
        case 'pm2-start':
            $require($available('pm2'), 'TOOL_UNAVAILABLE');
            if ($state['ecosystemFile'] !== null) {
                return $withRuntimeEnv($step('Start or reload ecosystem', ['pm2', 'startOrReload', $state['ecosystemFile']], 300));
            }
            $require($state['hasStartScript'] && is_array($manager) && empty($manager['ambiguous']));
            $require($available($manager['id']), 'TOOL_UNAVAILABLE');
            return $withRuntimeEnv($step('Start or reload application', ['pm2', 'start', $manager['id'], '--name', $state['processName'], '--', 'start'], 300));
        case 'pm2-restart':
            $require($available('pm2'), 'TOOL_UNAVAILABLE');
            return $withRuntimeEnv($step('Restart processes', ['pm2', 'restart', 'all', '--update-env'], 300));
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
            $definition = $step(ucfirst($verb) . ' process', ['pm2', $verb, $target, ...($verb === 'restart' ? ['--update-env'] : [])], 300);
            return $verb === 'restart' ? $withRuntimeEnv($definition) : $definition;
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
            return $steps(array_merge([
                ['compose-validate', 'Validate configuration', null],
                ['compose-deploy', 'Build and start services', null],
                ['compose-ps', 'Verify service state', null],
            ], !empty($state['expectedPort']) ? [
                ['compose-port-verify', 'Verify website entry port', null],
            ] : []));
        case 'node':
            if ($site->getType() !== Site::TYPE_NODEJS) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE']);
            return $steps(array_merge(
                [['node-install', 'Install dependencies', null]],
                $state['hasBuildScript'] ? [['node-run', 'Build application', ['script' => 'build']]] : [],
                array_merge([
                    ['pm2-start', 'Start or reload process', null],
                    ['pm2-save', 'Persist process state', null],
                ], !empty($state['expectedPort']) ? [
                    ['runtime-port-verify', 'Verify application port', null],
                ] : []),
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
                if (!empty($state['expectedPort'])) $pairs[] = ['runtime-port-verify', 'Verify application port', null];
            }
            return $steps($pairs);
    }
    respond(['ok' => false, 'code' => 'INVALID_ACTION']);
}

function executeOperationSteps(Site $site, array $steps): array
{
    $results = [];
    foreach ($steps as $stepDefinition) {
        $args = $stepDefinition['args'];
        $displayArgs = $args;
        $temporaryCompose = null;
        if (isset($stepDefinition['composeConfig'])) {
            $encoded = json_encode($stepDefinition['composeConfig'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if (!is_string($encoded)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
            $identity = siteIdentity($site);
            $runtimeDirectory = '/run/user/' . $identity['uid'];
            $composeDirectory = $runtimeDirectory . '/panelavo-compose';
            if (!is_dir($runtimeDirectory) || (int) (@fileowner($runtimeDirectory) ?: -1) !== $identity['uid']) {
                respond(['ok' => false, 'code' => 'TOOL_UNAVAILABLE', 'message' => 'The rootless Docker user runtime directory is unavailable.']);
            }
            if (!is_dir($composeDirectory) && !@mkdir($composeDirectory, 0700)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
            if (is_link($composeDirectory) || !@chown($composeDirectory, $identity['uid']) || !@chgrp($composeDirectory, $identity['gid']) || !@chmod($composeDirectory, 0700)) {
                respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
            }
            $temporaryCompose = $composeDirectory . '/' . hash('sha256', (string) $site->getDomainName()) . '-' . bin2hex(random_bytes(6)) . '.json';
            $previousUmask = umask(0077);
            try {
                if (@file_put_contents($temporaryCompose, $encoded, LOCK_EX) === false) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
            } finally {
                umask($previousUmask);
            }
            if (!@chown($temporaryCompose, $identity['uid']) || !@chgrp($temporaryCompose, $identity['gid']) || !@chmod($temporaryCompose, 0600)) {
                @unlink($temporaryCompose);
                respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
            }
            $args = array_map(static fn(string $arg): string => $arg === '@PANELAVO_COMPOSE_CONFIG@' ? $temporaryCompose : $arg, $args);
            $displayArgs = array_map(static fn(string $arg): string => $arg === '@PANELAVO_COMPOSE_CONFIG@' ? '[ephemeral port-mapped config]' : $arg, $displayArgs);
        }
        try {
            if (isset($stepDefinition['verifyOwnedPort'])) {
                $expectedPort = (int) $stepDefinition['verifyOwnedPort'];
                $capability = null;
                for ($attempt = 0; $attempt < 12; $attempt++) {
                    $capability = sitePortCapability($site, hostListeningPorts($site));
                    if (!empty($capability['listening']) || !empty($capability['conflict'])) break;
                    usleep(5000000);
                }
                if (!empty($capability['conflict']) || empty($capability['listening'])) {
                    $result = [
                        'code' => 1,
                        'timedOut' => false,
                        'stdout' => '',
                        'stderr' => (string) ($capability['detail'] ?? ('Port ' . $expectedPort . ' did not become site-owned.')),
                    ];
                } else {
                    $result = runSiteCommand($site, $args, $stepDefinition['timeout'], !empty($stepDefinition['asRoot']), (array) ($stepDefinition['env'] ?? []));
                }
            } else {
                $result = runSiteCommand($site, $args, $stepDefinition['timeout'], !empty($stepDefinition['asRoot']), (array) ($stepDefinition['env'] ?? []));
            }
        } finally {
            if ($temporaryCompose !== null) @unlink($temporaryCompose);
        }
        $results[] = [
            'command' => $stepDefinition['command'], 'label' => $stepDefinition['label'],
            'display' => implode(' ', $displayArgs), 'exitCode' => $result['code'],
            'timedOut' => $result['timedOut'],
            'output' => trim($result['stdout'] . ($result['stderr'] !== '' ? "\n" . $result['stderr'] : '')),
        ];
        if ($result['code'] !== 0) break;
    }
    return $results;
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

function initializeRootlessDocker(Site $site, string $fix, array &$results): void
{
    $identity = siteIdentity($site);
    $systemdHost = trim((string) @file_get_contents('/proc/1/comm')) === 'systemd';
    $cgroupV2Host = is_file('/sys/fs/cgroup/cgroup.controllers');
    if (!syntheticFixStep($results, $fix, 'Verify cgroup host', 'inspect PID 1 and /sys/fs/cgroup/cgroup.controllers', $systemdHost && $cgroupV2Host,
        $systemdHost && $cgroupV2Host ? 'The host uses systemd with cgroup v2.' : 'Rootless Docker requires systemd as PID 1 and cgroup v2.')) return;
    $subuid = subordinateRange('/etc/subuid', $identity['user']);
    $subgid = subordinateRange('/etc/subgid', $identity['user']);
    if (!$subuid || !$subgid) {
        if ((!$subuid && hasSubordinateEntry('/etc/subuid', $identity['user']))
            || (!$subgid && hasSubordinateEntry('/etc/subgid', $identity['user']))) {
            syntheticFixStep($results, $fix, 'Verify subordinate IDs', 'inspect /etc/subuid and /etc/subgid', false,
                'The site user has overlapping, duplicate, or undersized subordinate ranges. Correct them before initialization.');
            return;
        }
        $uidStart = nextSubordinateStart('/etc/subuid');
        $gidStart = nextSubordinateStart('/etc/subgid');
        if (!runFixStep($site, $results, $fix, 'Allocate subordinate IDs', [
            'usermod',
            '--add-subuids', $uidStart . '-' . ($uidStart + 65535),
            '--add-subgids', $gidStart . '-' . ($gidStart + 65535),
            $identity['user'],
        ], 60)) return;
        $subuid = subordinateRange('/etc/subuid', $identity['user']);
        $subgid = subordinateRange('/etc/subgid', $identity['user']);
        if (!syntheticFixStep($results, $fix, 'Verify subordinate IDs', 'inspect /etc/subuid and /etc/subgid', $subuid !== null && $subgid !== null,
            $subuid && $subgid ? 'Non-overlapping subordinate UID/GID ranges are ready.' : 'A safe subordinate UID/GID range could not be allocated.')) return;
    }
    bringUpRootlessUserDaemon($site, $fix, $results, true);
}

function configureRootlessDockerLogLimits(Site $site, string $fix, array &$results): bool
{
    $identity = siteIdentity($site);
    $directory = $identity['home'] . '/.config/docker';
    foreach ([$identity['home'] . '/.config', $directory] as $path) {
        if (is_link($path)) {
            return syntheticFixStep($results, $fix, 'Bound Docker container logs', 'write ~/.config/docker/daemon.json', false,
                'The Docker configuration path is a symbolic link.');
        }
        if (!is_dir($path) && !@mkdir($path, 0700)) {
            return syntheticFixStep($results, $fix, 'Bound Docker container logs', 'write ~/.config/docker/daemon.json', false,
                'The Docker configuration directory could not be created.');
        }
        @chown($path, $identity['uid']); @chgrp($path, $identity['gid']); @chmod($path, 0700);
    }
    $file = $directory . '/daemon.json';
    if (is_link($file)) {
        return syntheticFixStep($results, $fix, 'Bound Docker container logs', 'write ~/.config/docker/daemon.json', false,
            'The Docker daemon configuration is a symbolic link.');
    }
    $configuration = [];
    if (is_file($file)) {
        $decoded = json_decode((string) @file_get_contents($file), true);
        if (!is_array($decoded) || array_is_list($decoded)) {
            return syntheticFixStep($results, $fix, 'Bound Docker container logs', 'write ~/.config/docker/daemon.json', false,
                'The existing Docker daemon configuration is not a JSON object.');
        }
        $configuration = $decoded;
    }
    $driver = (string) ($configuration['log-driver'] ?? 'local');
    if (!in_array($driver, ['local', 'json-file'], true)) {
        return syntheticFixStep($results, $fix, 'Bound Docker container logs', 'write ~/.config/docker/daemon.json', true,
            'The configured ' . $driver . ' logging driver owns its external retention policy.');
    }
    $configuration['log-driver'] = $driver;
    $options = is_array($configuration['log-opts'] ?? null) ? $configuration['log-opts'] : [];
    $options['max-size'] = $options['max-size'] ?? '20m';
    $options['max-file'] = $options['max-file'] ?? '5';
    $configuration['log-opts'] = $options;
    $temporary = $file . '.tmp-' . bin2hex(random_bytes(4));
    $encoded = json_encode($configuration, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    $written = is_string($encoded)
        && @file_put_contents($temporary, $encoded . "\n", LOCK_EX) !== false
        && @chmod($temporary, 0600)
        && @chown($temporary, $identity['uid'])
        && @chgrp($temporary, $identity['gid'])
        && @rename($temporary, $file);
    if (!$written) @unlink($temporary);
    return syntheticFixStep($results, $fix, 'Bound Docker container logs', 'write ~/.config/docker/daemon.json', $written,
        $written ? 'Container logs retain at most five 20 MB files unless the site declares a stricter Compose policy.' : 'The Docker log policy could not be saved.');
}

// Per-user rootless bring-up: enable the site user's linger, start their user
// manager, install and start their private daemon, then verify readiness. Every
// command touches only the requesting site user's own runtime and login
// persistence, so this is safe for a site-write user, not just a Super Admin.
// $allowHostStorageFallback gates the single host-level step (installing
// fuse-overlayfs): the Super Admin host path allows it; the self-service path
// never installs packages and instead reports that a Super Admin must supply a
// storage driver.
function bringUpRootlessUserDaemon(Site $site, string $fix, array &$results, bool $allowHostStorageFallback): void
{
    $identity = siteIdentity($site);
    if (!runFixStep($site, $results, $fix, 'Enable user service persistence', ['loginctl', 'enable-linger', $identity['user']], 60)) return;
    if (!runFixStep($site, $results, $fix, 'Start the user manager', ['systemctl', 'start', 'user@' . $identity['uid'] . '.service'], 60)) return;
    $runtime = '/run/user/' . $identity['uid'];
    $ready = false;
    for ($attempt = 0; $attempt < 50; $attempt++) {
        clearstatcache(true, $runtime . '/bus');
        if (is_dir($runtime) && pathIsSocket($runtime . '/bus')
            && (int) (@fileowner($runtime) ?: -1) === $identity['uid']
            && (((int) @fileperms($runtime)) & 0777) === 0700
            && (int) (@fileowner($runtime . '/bus') ?: -1) === $identity['uid']) {
            $ready = true;
            break;
        }
        usleep(100000);
    }
    if (!syntheticFixStep($results, $fix, 'Verify user D-Bus', 'inspect ' . $runtime . '/bus', $ready,
        $ready ? 'The site user runtime directory and D-Bus socket are ready.' : 'The site user manager did not create a safe runtime directory and D-Bus socket.')) return;
    if (!configureRootlessDockerLogLimits($site, $fix, $results)) return;
    $setup = runSiteCommand(
        $site,
        ['/usr/bin/dockerd-rootless-setuptool.sh', 'install', '--force'],
        300,
        false,
        rootlessDockerEnvironment($site, true),
        $identity['home'],
    );
    $results[] = [
        'command' => $fix,
        'label' => 'Install the site user daemon',
        'display' => 'dockerd-rootless-setuptool.sh install --force',
        'exitCode' => $setup['code'],
        'timedOut' => $setup['timedOut'],
        'output' => trim($setup['stdout'] . ($setup['stderr'] !== '' ? "\n" . $setup['stderr'] : '')),
    ];
    if ($setup['code'] !== 0) return;
    $enable = runRootlessSystemdCommand($site, ['systemctl', '--user', 'enable', '--now', 'docker.service'], 120);
    $results[] = [
        'command' => $fix,
        'label' => 'Enable and start the site user daemon',
        'display' => 'systemctl --user enable --now docker.service',
        'exitCode' => $enable['code'],
        'timedOut' => $enable['timedOut'],
        'output' => trim($enable['stdout'] . ($enable['stderr'] !== '' ? "\n" . $enable['stderr'] : '')),
    ];
    if ($enable['code'] !== 0) return;
    for ($attempt = 0; $attempt < 100 && !pathIsSocket($runtime . '/docker.sock'); $attempt++) usleep(100000);
    $capability = rootlessCapability($site);
    if (!empty($capability['daemonAvailable']) && empty($capability['storageReady'])) {
        if (!$allowHostStorageFallback) {
            syntheticFixStep($results, $fix, 'Verify rootless storage', 'inspect the daemon storage driver', false,
                'The rootless daemon started but no supported storage driver is available. Ask a Super Admin to install fuse-overlayfs on the host.');
            return;
        }
        if (!runFixStep($site, $results, $fix, 'Install rootless storage fallback', ['apt-get', 'install', '-y', 'fuse-overlayfs'], 600)) return;
        $restart = runRootlessSystemdCommand($site, ['systemctl', '--user', 'restart', 'docker.service'], 120);
        $results[] = migrationStep($fix, 'Restart the site user daemon', 'systemctl --user restart docker.service', $restart);
        if ($restart['code'] !== 0) return;
        $capability = rootlessCapability($site);
    }
    syntheticFixStep($results, $fix, 'Verify rootless daemon', 'docker info on the site-user socket', !empty($capability['ready']),
        !empty($capability['ready'])
            ? 'Rootless Docker is ready with ' . ($capability['storageDriver'] ?? 'an available storage driver') . '.'
            : 'The daemon started but did not pass the complete rootless readiness check.');
}

// Site-write self-service rootless bring-up. Requires the host to already be
// provisioned (by setup.sh or a Super Admin host fix) and refuses — without
// mutating anything — when it is not. It never installs host packages or
// allocates subordinate ranges; it only starts the requesting site user's own
// daemon, which is why it is authorized for site-write users rather than a
// Super Admin.
function initializeRootlessRuntime(Site $site, string $fix, array &$results): void
{
    $provisioned = rootlessHostProvisioned($site);
    if (!syntheticFixStep($results, $fix, 'Verify host rootless support', 'inspect installed rootless packages and subordinate ranges', $provisioned['ready'],
        $provisioned['ready']
            ? 'The host already provides the rootless Docker prerequisites.'
            : 'The host is missing rootless prerequisites (' . implode(', ', $provisioned['missing']) . '). A Super Admin must provision the host before this runtime can start.')) return;
    bringUpRootlessUserDaemon($site, $fix, $results, false);
}

function rootfulComposeModel(Site $site, string $file): array
{
    $result = runSiteCommand($site, ['docker', 'compose', '-f', $file, '-p', composeProjectName($site), 'config', '--format', 'json'], 60, true);
    $model = $result['code'] === 0 ? json_decode(trim($result['stdout']), true) : null;
    if (!is_array($model)) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'The legacy rootful Compose project could not be resolved.']);
    return $model;
}

function migrationManifest(Site $site): ?array
{
    $path = rootlessMigrationPath($site);
    if (!is_file($path) || is_link($path)) return null;
    $value = json_decode((string) @file_get_contents($path), true);
    return is_array($value) ? $value : null;
}

function writeMigrationManifest(Site $site, array $manifest): void
{
    $path = rootlessMigrationPath($site);
    $temporary = $path . '.tmp-' . bin2hex(random_bytes(4));
    $encoded = json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if (!is_string($encoded) || @file_put_contents($temporary, $encoded, LOCK_EX) === false || !@chmod($temporary, 0600) || !@rename($temporary, $path)) {
        @unlink($temporary);
        respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    }
}

function migrationTreeEntries(string $source): Generator
{
    $real = realpath($source);
    if (!$real || is_link($source)) return;
    yield $real;
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($real, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST,
    );
    foreach ($iterator as $entry) {
        $path = $entry->getPathname();
        if ($entry->isLink()) continue;
        yield $path;
    }
}

function migrationTreeContainsSymlink(string $source): bool
{
    $real = realpath($source);
    if (!$real || is_link($source)) return true;
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($real, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST,
    );
    foreach ($iterator as $entry) if ($entry->isLink()) return true;
    return false;
}

function ownershipInventory(string $source, array $allowedUids, array $allowedGids): array
{
    if (migrationTreeContainsSymlink($source)) {
        return ['valid' => false, 'detail' => 'A bind source contains a symbolic link; automatic ownership translation requires a physical tree.', 'count' => 0];
    }
    $uids = []; $gids = []; $unknownUids = []; $unknownGids = []; $count = 0;
    foreach (migrationTreeEntries($source) as $path) {
        if (++$count > 200000) return ['valid' => false, 'detail' => 'A bind source contains more than 200,000 paths; migrate it manually.', 'count' => $count];
        $stat = @lstat($path);
        if (!is_array($stat)) return ['valid' => false, 'detail' => 'A bind-mounted path changed during ownership inspection.', 'count' => $count];
        $uid = (int) $stat['uid']; $gid = (int) $stat['gid'];
        $uids[$uid] = ($uids[$uid] ?? 0) + 1; $gids[$gid] = ($gids[$gid] ?? 0) + 1;
        if (!in_array($uid, $allowedUids, true)) $unknownUids[$uid] = true;
        if (!in_array($gid, $allowedGids, true)) $unknownGids[$gid] = true;
    }
    return [
        'valid' => !$unknownUids && !$unknownGids,
        'detail' => $unknownUids || $unknownGids
            ? 'Unclassified owners were found (UIDs: ' . implode(', ', array_keys($unknownUids)) . '; GIDs: ' . implode(', ', array_keys($unknownGids)) . ').'
            : 'Every inode owner has a deterministic rootless mapping.',
        'count' => $count,
        'uids' => $uids,
        'gids' => $gids,
    ];
}

function revalidateManifestOwnership(array $manifest): bool
{
    $identity = (array) ($manifest['identity'] ?? []);
    foreach ((array) ($manifest['sources'] ?? []) as $source => $definition) {
        $inventory = ownershipInventory(
            (string) $source,
            array_values(array_unique([0, (int) ($identity['uid'] ?? -1), (int) ($definition['runtimeUid'] ?? -1)])),
            array_values(array_unique([0, (int) ($identity['gid'] ?? -1), (int) ($definition['runtimeGid'] ?? -1)])),
        );
        if (empty($inventory['valid']) || json_encode($inventory) !== json_encode($definition['inventory'] ?? null)) return false;
    }
    return true;
}

function rootlessMappedId(int $containerId, int $siteId, int $subordinateStart): int
{
    return $containerId === 0 ? $siteId : $subordinateStart + $containerId - 1;
}

function mappedBindAncestors(Site $site, string $source): array
{
    $home = realpath(siteIdentity($site)['home']);
    $parent = realpath(dirname($source));
    if (!$home || !$parent || ($parent !== $home && !pathIsContained($parent, $home))) return [];
    $paths = [];
    while ($parent === $home || pathIsContained($parent, $home)) {
        $paths[] = $parent;
        if ($parent === $home) break;
        $next = dirname($parent);
        if ($next === $parent) return [];
        $parent = $next;
    }
    return array_reverse($paths);
}

function mappedBindAclIsAvailable(Site $site, string $source, int $mappedUid): bool
{
    $getfacl = findSiteTool('/root', 'getfacl', true);
    $ancestors = mappedBindAncestors($site, $source);
    if (!$getfacl || !$ancestors) return false;
    $treeAcl = runSiteCommand($site, [$getfacl, '--numeric', '--recursive', '--absolute-names', $source], 900, true);
    $ancestorAcl = runSiteCommand($site, array_merge([$getfacl, '--numeric', '--absolute-names'], $ancestors), 300, true);
    $output = $treeAcl['stdout'] . "\n" . $ancestorAcl['stdout'];
    return $treeAcl['code'] === 0 && $ancestorAcl['code'] === 0
        && !str_contains($output, '[stdout truncated by Panelavo]')
        && preg_match('/^(?:default:)?user:' . preg_quote((string) $mappedUid, '/') . ':/m', $output) !== 1;
}

function changeMappedBindAccess(Site $site, array $manifest, bool $grant): bool
{
    $setfacl = findSiteTool('/root', 'setfacl', true);
    if (!$setfacl) return false;
    $identity = $manifest['identity']; $subuid = $manifest['subuid'];
    $ok = true;
    foreach ((array) ($manifest['sources'] ?? []) as $source => $definition) {
        $mappedUid = rootlessMappedId((int) ($definition['runtimeUid'] ?? 0), (int) $identity['uid'], (int) $subuid['start']);
        if ($mappedUid === (int) $identity['uid']) continue;
        $ancestors = mappedBindAncestors($site, (string) $source);
        if (!$ancestors) return false;
        $ancestorArgs = $grant
            ? [$setfacl, '--modify', 'u:' . $mappedUid . ':--x']
            : [$setfacl, '--remove', 'u:' . $mappedUid];
        $ancestorResult = runSiteCommand($site, array_merge($ancestorArgs, $ancestors), 300, true);
        $accessResult = runSiteCommand($site, $grant
            ? [$setfacl, '--physical', '--recursive', '--modify', 'u:' . $mappedUid . ':rwX', (string) $source]
            : [$setfacl, '--physical', '--recursive', '--remove', 'u:' . $mappedUid, (string) $source], 900, true);
        $defaultResult = runSiteCommand($site, [
            '/usr/bin/find', '-P', (string) $source, '-type', 'd', '-exec', $setfacl,
            $grant ? '--modify' : '--remove', ($grant ? 'd:u:' . $mappedUid . ':rwx' : 'd:u:' . $mappedUid), '{}', '+',
        ], 900, true);
        if ($ancestorResult['code'] !== 0 || $accessResult['code'] !== 0 || $defaultResult['code'] !== 0) $ok = false;
    }
    return $ok;
}

function effectiveContainerRuntimeIdentity(array $primary, array $processes): ?array
{
    $primaryUid = (int) ($primary['uid'] ?? -1);
    $primaryGid = (int) ($primary['gid'] ?? -1);
    if ($primaryUid < 0 || $primaryGid < 0) return null;
    if ($primaryUid !== 0 || $primaryGid !== 0) return ['uid' => $primaryUid, 'gid' => $primaryGid];
    $nonRoot = [];
    foreach ($processes as $process) {
        $uid = (int) ($process['uid'] ?? -1); $gid = (int) ($process['gid'] ?? -1);
        if ($uid < 0 || $gid < 0 || ($uid === 0 && $gid === 0)) continue;
        $nonRoot[$uid . ':' . $gid] = ['uid' => $uid, 'gid' => $gid];
    }
    if (count($nonRoot) > 1) return null;
    return $nonRoot ? array_values($nonRoot)[0] : ['uid' => 0, 'gid' => 0];
}

function processNumericIdentity(int $pid): ?array
{
    $status = $pid > 1 ? @file('/proc/' . $pid . '/status', FILE_IGNORE_NEW_LINES) : false;
    $uid = null; $gid = null;
    foreach (is_array($status) ? $status : [] as $line) {
        if (preg_match('/^Uid:\s+(\d+)/', $line, $match)) $uid = (int) $match[1];
        if (preg_match('/^Gid:\s+(\d+)/', $line, $match)) $gid = (int) $match[1];
    }
    return $uid === null || $gid === null ? null : ['uid' => $uid, 'gid' => $gid];
}

function rootfulServiceIdentity(Site $site, string $file, string $service): array
{
    $id = runSiteCommand($site, ['docker', 'compose', '-f', $file, '-p', composeProjectName($site), 'ps', '-q', $service], 20, true);
    $container = trim($id['stdout']);
    if ($id['code'] !== 0 || !preg_match('/^[0-9a-f]{12,64}$/i', $container)) {
        respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'Legacy service "' . $service . '" must be running so its numeric runtime identity can be verified.']);
    }
    $pidResult = runSiteCommand($site, ['docker', 'inspect', '--format', '{{.State.Pid}}', $container], 20, true);
    $pid = (int) trim($pidResult['stdout']);
    $primary = processNumericIdentity($pid);
    if ($primary === null) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'The runtime UID/GID for service "' . $service . '" could not be resolved.']);
    $processes = [];
    if ($primary['uid'] === 0 && $primary['gid'] === 0) {
        // `init: true` and privilege-dropping entrypoints leave PID 1 as root
        // while the long-running application child uses the effective bind UID.
        $top = runSiteCommand($site, ['docker', 'top', $container, '-eo', 'pid'], 20, true);
        foreach (preg_split('/\R/', trim($top['stdout'])) ?: [] as $line) {
            $candidate = trim($line);
            if (!ctype_digit($candidate)) continue;
            $identity = processNumericIdentity((int) $candidate);
            if ($identity !== null) $processes[] = $identity;
        }
    }
    $effective = effectiveContainerRuntimeIdentity($primary, $processes);
    if ($effective === null) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'Service "' . $service . '" has multiple non-root runtime identities, so bind ownership cannot be translated safely.']);
    return ['container' => $container] + $effective;
}

function analyzeRootlessMigration(Site $site, array $model): array
{
    $root = realpath(siteRootPath($site));
    $identity = siteIdentity($site);
    $subuid = subordinateRange('/etc/subuid', $identity['user']);
    $subgid = subordinateRange('/etc/subgid', $identity['user']);
    if (!$root || !$subuid || !$subgid) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'The site user has no valid subordinate UID/GID ranges.']);
    foreach ((array) ($model['networks'] ?? []) as $network) {
        if (is_array($network) && !empty($network['external'])) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'External networks are not supported by automatic rootless migration.']);
    }
    $sources = [];
    $services = [];
    $file = findComposeFile($root);
    if ($file === null) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE']);
    foreach ((array) ($model['services'] ?? []) as $name => $service) {
        if (!is_array($service)) continue;
        $binds = [];
        foreach ((array) ($service['volumes'] ?? []) as $volume) {
            if (!is_array($volume)) continue;
            if (($volume['type'] ?? '') !== 'bind') respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'Named and external volumes are not supported by automatic rootless migration.']);
            if (!empty($volume['read_only'])) continue;
            $source = realpath((string) ($volume['source'] ?? ''));
            if (!$source || !pathIsContained($source, $root) || is_link((string) $volume['source'])) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'Every writable bind source must be a physical path inside the site root.']);
            $binds[] = $source;
        }
        $runtime = $binds ? rootfulServiceIdentity($site, $file, (string) $name) : ['container' => '', 'uid' => 0, 'gid' => 0];
        if (($runtime['uid'] !== 0 && $runtime['uid'] === $identity['uid']) || ($runtime['gid'] !== 0 && $runtime['gid'] === $identity['gid'])) {
            respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'A container runtime UID/GID collides with the site user host identity.']);
        }
        $services[(string) $name] = $runtime + ['binds' => $binds];
        foreach ($binds as $source) {
            $sources[$source]['services'][] = (string) $name;
            $sources[$source]['uids'][$runtime['uid']] = true;
            $sources[$source]['gids'][$runtime['gid']] = true;
        }
    }
    $sourcePaths = array_keys($sources);
    foreach ($sourcePaths as $index => $source) {
        foreach (array_slice($sourcePaths, $index + 1) as $other) {
            if (pathIsContained($source, $other) || pathIsContained($other, $source)) {
                respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'Overlapping writable bind sources cannot be translated safely: ' . $source . ' and ' . $other . '.']);
            }
        }
    }
    foreach ($sources as $source => &$definition) {
        $runtimeUids = array_map('intval', array_keys($definition['uids']));
        $runtimeGids = array_map('intval', array_keys($definition['gids']));
        if (count($runtimeUids) > 1 || count($runtimeGids) > 1) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'Services with conflicting runtime identities share bind source ' . $source . '.']);
        $definition['runtimeUid'] = $runtimeUids[0] ?? 0;
        $definition['runtimeGid'] = $runtimeGids[0] ?? 0;
        $mappedUid = rootlessMappedId($definition['runtimeUid'], $identity['uid'], (int) $subuid['start']);
        if ($mappedUid !== $identity['uid'] && !mappedBindAclIsAvailable($site, $source, $mappedUid)) {
            respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => $source . ': the mapped runtime UID already has an ACL entry or the ACL inventory could not be completed safely.']);
        }
        $definition['inventory'] = ownershipInventory($source, array_values(array_unique([0, $identity['uid'], $definition['runtimeUid']])), array_values(array_unique([0, $identity['gid'], $definition['runtimeGid']])));
        if (empty($definition['inventory']['valid'])) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => $source . ': ' . $definition['inventory']['detail']]);
        unset($definition['uids'], $definition['gids']);
    }
    unset($definition);
    return ['identity' => $identity, 'subuid' => $subuid, 'subgid' => $subgid, 'services' => $services, 'sources' => $sources];
}

function migrationStatus(Site $site, ?array $compose): array
{
    $manifest = migrationManifest($site);
    $expired = is_array($manifest) && time() - (int) ($manifest['updatedAt'] ?? 0) > PANELAVO_ROOTLESS_MIGRATION_TTL;
    $rootful = false;
    if (is_array($compose) && !empty($compose['file']) && is_executable('/usr/bin/docker')) {
        $legacy = runSiteCommand($site, ['docker', 'compose', '-f', $compose['file'], '-p', composeProjectName($site), 'ps', '-q'], 15, true);
        $rootful = $legacy['code'] === 0 && trim($legacy['stdout']) !== '';
    }
    return [
        'legacyRootfulDetected' => $rootful,
        'preparedServices' => $expired ? [] : array_values(array_keys((array) ($manifest['prepared'] ?? []))),
        'allServicesPrepared' => !$expired && !empty($manifest['allPrepared']),
        'preparedAt' => !$expired ? ($manifest['updatedAtIso'] ?? null) : null,
        'expiresAt' => !$expired && isset($manifest['updatedAt']) ? gmdate(DATE_ATOM, (int) $manifest['updatedAt'] + PANELAVO_ROOTLESS_MIGRATION_TTL) : null,
        'recoveryRequired' => is_file(rootlessMigrationPath($site, 'ownership.journal')),
    ];
}

function rootlessServiceImageId(Site $site, string $file, string $service, array $model): ?string
{
    $configured = trim((string) ($model['services'][$service]['image'] ?? ''));
    if ($configured !== '') {
        $inspect = runRootlessDockerCommand($site, ['docker', 'image', 'inspect', '--format', '{{.Id}}', $configured], 30);
        $id = trim($inspect['stdout']);
        return $inspect['code'] === 0 && preg_match('/^sha256:[0-9a-f]{64}$/i', $id) ? $id : null;
    }
    $resolved = runRootlessDockerCommand($site, [
        'docker', 'compose', '-f', $file, '-p', composeProjectName($site),
        'config', '--images', $service,
    ], 30);
    $names = array_values(array_unique(array_filter(preg_split('/\R/', trim($resolved['stdout'])) ?: [], 'strlen')));
    if ($resolved['code'] !== 0 || !$names) return null;
    $matches = [];
    foreach ($names as $name) {
        $inspect = runRootlessDockerCommand($site, ['docker', 'image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "com.docker.compose.service"}}', $name], 30);
        if ($inspect['code'] !== 0) continue;
        $parts = preg_split('/\s+/', trim($inspect['stdout']), 2) ?: [];
        if (($parts[1] ?? '') === $service && preg_match('/^sha256:[0-9a-f]{64}$/i', (string) ($parts[0] ?? ''))) $matches[$parts[0]] = true;
    }
    return count($matches) === 1 ? (string) array_key_first($matches) : null;
}

function prepareRootlessMigration(Site $site, string $service): array
{
    $root = siteRootPath($site);
    $file = findComposeFile($root);
    if (!$file || !preg_match('/^[A-Za-z0-9._-]{1,100}$/', $service)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    $rootless = rootlessCapability($site);
    if (empty($rootless['ready'])) respond(['ok' => false, 'code' => 'TOOL_UNAVAILABLE', 'message' => 'Initialize the site user rootless daemon first.']);
    $model = rootfulComposeModel($site, $file);
    if (!isset($model['services'][$service])) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    $analysis = analyzeRootlessMigration($site, $model);
    $digest = hash('sha256', json_encode($model, JSON_UNESCAPED_SLASHES) ?: '');
    $manifest = migrationManifest($site) ?? [];
    if (($manifest['configDigest'] ?? $digest) !== $digest
        || (($manifest['subuid'] ?? $analysis['subuid']) !== $analysis['subuid'])
        || (($manifest['subgid'] ?? $analysis['subgid']) !== $analysis['subgid'])
        || (($manifest['expectedPort'] ?? expectedSitePort($site)) !== expectedSitePort($site))) {
        $manifest = [];
    }
    foreach ((array) ($manifest['prepared'] ?? []) as $preparedService => $expectedImage) {
        $imageId = rootlessServiceImageId($site, $file, (string) $preparedService, $model);
        if ($imageId === null || !hash_equals((string) $expectedImage, $imageId)) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'The prepared image for service "' . $preparedService . '" changed or is missing.']);
    }
    foreach ((array) ($analysis['services'] ?? []) as $serviceName => $definition) {
        $previous = (string) ($manifest['services'][$serviceName]['container'] ?? '');
        if ($previous !== '' && !hash_equals($previous, (string) ($definition['container'] ?? ''))) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'A legacy container changed after preparation. Prepare again.']);
    }
    $pull = runRootlessDockerCommand($site, ['docker', 'compose', '-f', $file, '-p', composeProjectName($site), 'pull', '--ignore-buildable', $service], 900);
    if ($pull['code'] !== 0) return ['steps' => [['command' => 'prepare-rootless-migration', 'label' => 'Pull ' . $service, 'display' => 'docker compose pull ' . $service, 'exitCode' => $pull['code'], 'timedOut' => $pull['timedOut'], 'output' => trim($pull['stdout'] . "\n" . $pull['stderr'])]]];
    $build = runRootlessDockerCommand($site, ['docker', 'compose', '-f', $file, '-p', composeProjectName($site), 'build', $service], 900);
    $steps = [
        ['command' => 'prepare-rootless-migration', 'label' => 'Pull ' . $service, 'display' => 'docker compose pull ' . $service, 'exitCode' => 0, 'timedOut' => false, 'output' => trim($pull['stdout'] . "\n" . $pull['stderr'])],
        ['command' => 'prepare-rootless-migration', 'label' => 'Build ' . $service, 'display' => 'docker compose build ' . $service, 'exitCode' => $build['code'], 'timedOut' => $build['timedOut'], 'output' => trim($build['stdout'] . "\n" . $build['stderr'])],
    ];
    if ($build['code'] !== 0) return ['steps' => $steps];
    $imageId = rootlessServiceImageId($site, $file, $service, $model);
    if ($imageId === null) {
        $steps[] = ['command' => 'prepare-rootless-migration', 'label' => 'Verify ' . $service . ' image', 'display' => 'inspect the prepared service image', 'exitCode' => 1, 'timedOut' => false, 'output' => 'No unique prepared image ID was found.'];
        return ['steps' => $steps];
    }
    $manifest = array_replace($manifest, [
        'domain' => (string) $site->getDomainName(), 'file' => $file, 'configDigest' => $digest,
        'services' => $analysis['services'], 'sources' => $analysis['sources'], 'identity' => $analysis['identity'],
        'subuid' => $analysis['subuid'], 'subgid' => $analysis['subgid'], 'expectedPort' => expectedSitePort($site),
        'updatedAt' => time(), 'updatedAtIso' => gmdate(DATE_ATOM),
    ]);
    $manifest['prepared'][$service] = $imageId;
    $manifest['allPrepared'] = count(array_diff(array_keys((array) $model['services']), array_keys((array) $manifest['prepared']))) === 0;
    writeMigrationManifest($site, $manifest);
    return ['steps' => $steps, 'message' => $service . ' is prepared in the rootless image store.'];
}

function writeRootlessComposeConfig(Site $site, array $config): string
{
    $identity = siteIdentity($site);
    $directory = '/run/user/' . $identity['uid'] . '/panelavo-compose';
    if (!is_dir(dirname($directory)) || (int) (@fileowner(dirname($directory)) ?: -1) !== $identity['uid']) respond(['ok' => false, 'code' => 'TOOL_UNAVAILABLE']);
    if (!is_dir($directory) && !@mkdir($directory, 0700)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    if (is_link($directory) || !@chown($directory, $identity['uid']) || !@chgrp($directory, $identity['gid']) || !@chmod($directory, 0700)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    $path = $directory . '/migration-' . bin2hex(random_bytes(8)) . '.json';
    $encoded = json_encode($config, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if (!is_string($encoded) || @file_put_contents($path, $encoded, LOCK_EX) === false
        || !@chown($path, $identity['uid']) || !@chgrp($path, $identity['gid']) || !@chmod($path, 0600)) {
        @unlink($path); respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    }
    return $path;
}

function translateMigrationOwnership(Site $site, array $manifest): string
{
    $journal = rootlessMigrationPath($site, 'ownership.journal');
    if (is_file($journal)) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'An ownership recovery journal already exists. Recover it before retrying cutover.']);
    $handle = @fopen($journal, 'xb');
    if (!$handle || !@chmod($journal, 0600)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    $identity = $manifest['identity']; $subuid = $manifest['subuid']; $subgid = $manifest['subgid'];
    try {
        foreach ((array) ($manifest['sources'] ?? []) as $source => $definition) {
            foreach (migrationTreeEntries((string) $source) as $path) {
                $stat = @lstat($path);
                if (!is_array($stat)) throw new RuntimeException('A bind path changed during ownership translation.');
                $oldUid = (int) $stat['uid']; $oldGid = (int) $stat['gid'];
                $newUid = $oldUid === (int) $identity['uid'] ? $oldUid : rootlessMappedId($oldUid, (int) $identity['uid'], (int) $subuid['start']);
                $newGid = $oldGid === (int) $identity['gid'] ? $oldGid : rootlessMappedId($oldGid, (int) $identity['gid'], (int) $subgid['start']);
                if ($newUid === $oldUid && $newGid === $oldGid) continue;
                if (fwrite($handle, base64_encode($path) . "\t" . $oldUid . "\t" . $oldGid . "\n") === false) throw new RuntimeException('The ownership journal could not be written.');
                if (($newUid !== $oldUid && !@chown($path, $newUid)) || ($newGid !== $oldGid && !@chgrp($path, $newGid))) {
                    throw new RuntimeException('Ownership translation failed for a bind-mounted path.');
                }
            }
        }
    } catch (Throwable $error) {
        fclose($handle);
        restoreMigrationOwnership($site, $manifest);
        throw $error;
    }
    fclose($handle);
    ensureSiteProjectAccess($site);
    if (!changeMappedBindAccess($site, $manifest, true)) {
        restoreMigrationOwnership($site, $manifest);
        throw new RuntimeException('Mapped runtime ACL access could not be applied safely.');
    }
    return $journal;
}

function restoreMigrationOwnership(Site $site, array $manifest): bool
{
    $journal = rootlessMigrationPath($site, 'ownership.journal');
    if (!is_file($journal) || is_link($journal)) return true;
    $lines = @file($journal, FILE_IGNORE_NEW_LINES);
    if (!is_array($lines)) return false;
    $ok = changeMappedBindAccess($site, $manifest, false); $journaled = [];
    foreach (array_reverse($lines) as $line) {
        $parts = explode("\t", $line);
        $path = isset($parts[0]) ? base64_decode($parts[0], true) : false;
        if (!is_string($path) || !isset($parts[1], $parts[2]) || !ctype_digit($parts[1]) || !ctype_digit($parts[2])) { $ok = false; continue; }
        $journaled[$path] = true;
        $contained = false;
        foreach (array_keys((array) ($manifest['sources'] ?? [])) as $source) if ($path === $source || pathIsContained($path, (string) $source)) { $contained = true; break; }
        if (!$contained || is_link($path) || !file_exists($path)) continue;
        if (!@chown($path, (int) $parts[1]) || !@chgrp($path, (int) $parts[2])) $ok = false;
    }
    // Files created after translation are not in the journal. Reverse any
    // subordinate owner deterministically; site-user ownership is retained
    // because it is also the valid rootless representation of container root.
    $subuidStart = (int) ($manifest['subuid']['start'] ?? 0); $subuidCount = (int) ($manifest['subuid']['count'] ?? 0);
    $subgidStart = (int) ($manifest['subgid']['start'] ?? 0); $subgidCount = (int) ($manifest['subgid']['count'] ?? 0);
    foreach (array_keys((array) ($manifest['sources'] ?? [])) as $source) {
        foreach (migrationTreeEntries((string) $source) as $path) {
            if (isset($journaled[$path])) continue;
            $stat = @lstat($path); if (!is_array($stat)) { $ok = false; continue; }
            $uid = (int) $stat['uid']; $gid = (int) $stat['gid'];
            if ($uid >= $subuidStart && $uid < $subuidStart + $subuidCount && !@chown($path, $uid - $subuidStart + 1)) $ok = false;
            if ($gid >= $subgidStart && $gid < $subgidStart + $subgidCount && !@chgrp($path, $gid - $subgidStart + 1)) $ok = false;
        }
    }
    ensureSiteProjectAccess($site);
    if ($ok) @unlink($journal);
    return $ok;
}

function migrationStep(string $command, string $label, string $display, array $result): array
{
    return ['command' => $command, 'label' => $label, 'display' => $display, 'exitCode' => $result['code'], 'timedOut' => $result['timedOut'] ?? false,
        'output' => trim((string) ($result['stdout'] ?? '') . (!empty($result['stderr']) ? "\n" . $result['stderr'] : ''))];
}

function decodeComposePsRows(string $output): array
{
    $decoded = json_decode(trim($output), true);
    if (is_array($decoded)) return array_is_list($decoded) ? $decoded : [$decoded];
    $rows = [];
    foreach (preg_split('/\R/', trim($output)) ?: [] as $line) {
        $row = json_decode($line, true);
        if (is_array($row)) $rows[] = $row;
    }
    return $rows;
}

function composeMigrationRowsReady(array $rows, int $serviceCount): bool
{
    if (count($rows) !== $serviceCount) return false;
    foreach ($rows as $row) {
        $health = strtolower((string) ($row['Health'] ?? ''));
        if (($row['State'] ?? '') !== 'running' || $health === 'starting' || $health === 'unhealthy') return false;
    }
    return true;
}

function waitForRootlessCompose(Site $site, string $file, int $serviceCount): array
{
    $last = ['code' => 1, 'timedOut' => false, 'stdout' => '', 'stderr' => 'No service-state probe ran.'];
    for ($attempt = 0; $attempt < 45; $attempt++) {
        $last = runRootlessDockerCommand($site, ['docker', 'compose', '-f', $file, '-p', composeProjectName($site), 'ps', '-a', '--format', 'json'], 30);
        $rows = $last['code'] === 0 ? decodeComposePsRows($last['stdout']) : [];
        if ($last['code'] === 0 && composeMigrationRowsReady($rows, $serviceCount)) return $last;
        if (count(array_filter($rows, static fn(array $row): bool => strtolower((string) ($row['Health'] ?? '')) === 'unhealthy')) > 0) break;
        usleep(1000000);
    }
    $last['code'] = 1;
    $last['stderr'] = trim((string) ($last['stderr'] ?? '') . "\nOne or more rootless services did not become running and healthy.");
    return $last;
}

function waitForLoopbackHttp(Site $site, int $port): array
{
    $last = ['code' => 1, 'timedOut' => false, 'stdout' => '', 'stderr' => 'No HTTP readiness probe ran.'];
    for ($attempt = 0; $attempt < 30; $attempt++) {
        $last = runSiteCommand($site, ['curl', '--fail', '--silent', '--show-error', '--max-time', '5', 'http://127.0.0.1:' . $port . '/'], 10, true);
        if ($last['code'] === 0) return $last;
        usleep(1000000);
    }
    return $last;
}

function cutoverRootlessMigration(Site $site): array
{
    $manifest = migrationManifest($site);
    if (!$manifest || empty($manifest['allPrepared']) || time() - (int) ($manifest['updatedAt'] ?? 0) > PANELAVO_ROOTLESS_MIGRATION_TTL) {
        respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'Prepare every service again before cutover.']);
    }
    $file = (string) $manifest['file'];
    $model = rootfulComposeModel($site, $file);
    $digest = hash('sha256', json_encode($model, JSON_UNESCAPED_SLASHES) ?: '');
    if (!hash_equals((string) $manifest['configDigest'], $digest)) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'The Compose configuration changed after preparation.']);
    $analysis = analyzeRootlessMigration($site, $model);
    if (($manifest['subuid'] ?? null) !== $analysis['subuid'] || ($manifest['subgid'] ?? null) !== $analysis['subgid']) {
        respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'The site user subordinate UID/GID ranges changed after preparation.']);
    }
    if (($manifest['expectedPort'] ?? null) !== expectedSitePort($site)) {
        respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'The CloudPanel entry port changed after preparation.']);
    }
    foreach ((array) ($analysis['services'] ?? []) as $service => $definition) {
        $expectedContainer = (string) ($manifest['services'][$service]['container'] ?? '');
        if ($expectedContainer !== (string) ($definition['container'] ?? '')) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'A legacy rootful container changed after preparation.']);
        $expectedImage = (string) ($manifest['prepared'][$service] ?? '');
        $imageId = rootlessServiceImageId($site, $file, (string) $service, $model);
        if ($expectedImage === '' || $imageId === null || !hash_equals($expectedImage, $imageId)) {
            respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'A prepared rootless image changed or is missing.']);
        }
    }
    foreach ($analysis['sources'] as $source => $definition) {
        if (json_encode($definition['inventory']) !== json_encode($manifest['sources'][$source]['inventory'] ?? null)) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'Bind-mounted ownership changed after preparation. Prepare again.']);
    }
    $composeCapability = composeCapability($site, siteRootPath($site), $file);
    if (empty($composeCapability['ready']) && empty($composeCapability['daemonAvailable'])) respond(['ok' => false, 'code' => 'TOOL_UNAVAILABLE']);
    $runtimeConfig = $composeCapability['_runtimeConfig'] ?? null;
    if (!is_array($runtimeConfig)) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE']);
    $runtimeFile = writeRootlessComposeConfig($site, $runtimeConfig);
    $steps = [];
    $rootfulStop = runSiteCommand($site, ['docker', 'compose', '-f', $file, '-p', composeProjectName($site), 'stop'], 300, true);
    $steps[] = migrationStep('cutover-rootless-migration', 'Stop legacy rootful project', 'docker compose stop', $rootfulStop);
    if ($rootfulStop['code'] !== 0) { @unlink($runtimeFile); return ['steps' => $steps]; }
    if (!revalidateManifestOwnership($manifest)) {
        $restart = runSiteCommand($site, ['docker', 'compose', '-f', $file, '-p', composeProjectName($site), 'start'], 300, true);
        $steps[] = migrationStep('cutover-rootless-migration', 'Restart legacy rootful project', 'docker compose start', $restart);
        @unlink($runtimeFile);
        $steps[] = [
            'command' => 'cutover-rootless-migration', 'label' => 'Revalidate bind ownership',
            'display' => 'rescan stopped bind sources', 'exitCode' => 1, 'timedOut' => false,
            'output' => 'Bind ownership changed or a symlink appeared after preparation. The legacy project was restarted without translating ownership.',
        ];
        return ['steps' => $steps];
    }
    try {
        translateMigrationOwnership($site, $manifest);
        $steps[] = ['command' => 'cutover-rootless-migration', 'label' => 'Translate bind ownership', 'display' => 'journaled UID/GID translation and ACL repair', 'exitCode' => 0, 'timedOut' => false, 'output' => 'Bind ownership was translated and the site-user ACL invariant was reapplied.'];
        foreach ((array) ($manifest['sources'] ?? []) as $source => $definition) {
            $mappedUid = rootlessMappedId((int) ($definition['runtimeUid'] ?? 0), (int) $manifest['identity']['uid'], (int) $manifest['subuid']['start']);
            $mappedGid = rootlessMappedId((int) ($definition['runtimeGid'] ?? 0), (int) $manifest['identity']['gid'], (int) $manifest['subgid']['start']);
            $access = runSiteCommand($site, ['setpriv', '--reuid=' . $mappedUid, '--regid=' . $mappedGid, '--clear-groups', '/usr/bin/test', '-r', (string) $source], 30, true);
            if ($access['code'] === 0) $access = runSiteCommand($site, ['setpriv', '--reuid=' . $mappedUid, '--regid=' . $mappedGid, '--clear-groups', '/usr/bin/test', '-w', (string) $source], 30, true);
            $steps[] = migrationStep('cutover-rootless-migration', 'Verify bind access', 'test read/write access as mapped UID ' . $mappedUid, $access);
            if ($access['code'] !== 0) throw new RuntimeException('Mapped runtime identity cannot read and write bind source ' . $source . '.');
        }
        $up = runRootlessDockerCommand($site, ['docker', 'compose', '-f', $runtimeFile, '-p', composeProjectName($site), 'up', '-d', '--no-build', '--remove-orphans'], 300);
        $steps[] = migrationStep('cutover-rootless-migration', 'Start prepared rootless project', 'docker compose up -d --no-build --remove-orphans', $up);
        $ps = $up['code'] === 0
            ? waitForRootlessCompose($site, $runtimeFile, count((array) $model['services']))
            : ['code' => 1, 'timedOut' => false, 'stdout' => '', 'stderr' => 'Rootless start failed.'];
        $steps[] = migrationStep('cutover-rootless-migration', 'Verify rootless service state', 'docker compose ps -a', $ps);
        $verify = $up['code'] === 0 && $ps['code'] === 0 && !empty($composeCapability['expectedPort'])
            ? waitForLoopbackHttp($site, (int) $composeCapability['expectedPort'])
            : ['code' => 1, 'timedOut' => false, 'stdout' => '', 'stderr' => 'Rootless service-state verification failed.'];
        $steps[] = migrationStep('cutover-rootless-migration', 'Verify website entry port', 'HTTP probe on the CloudPanel loopback port', $verify);
        if ($up['code'] === 0 && $ps['code'] === 0 && $verify['code'] === 0) {
            $cleanup = runSiteCommand($site, ['docker', 'compose', '-f', $file, '-p', composeProjectName($site), 'down', '--remove-orphans', '--rmi', 'local'], 300, true);
            $steps[] = migrationStep('cutover-rootless-migration', 'Remove legacy rootful project', 'docker compose down --remove-orphans --rmi local', $cleanup);
            if ($cleanup['code'] === 0) {
                @unlink(rootlessMigrationPath($site, 'ownership.journal'));
                @unlink(rootlessMigrationPath($site));
            }
            return ['steps' => $steps];
        }
    } catch (Throwable $error) {
        $steps[] = ['command' => 'cutover-rootless-migration', 'label' => 'Translate bind ownership', 'display' => 'journaled UID/GID translation', 'exitCode' => 1, 'timedOut' => false, 'output' => $error->getMessage()];
    } finally {
        @unlink($runtimeFile);
    }
    $down = runRootlessDockerCommand($site, ['docker', 'compose', '-f', $file, '-p', composeProjectName($site), 'down', '--remove-orphans'], 300);
    $steps[] = migrationStep('cutover-rootless-migration', 'Remove incomplete rootless project', 'docker compose down --remove-orphans', $down);
    $restored = restoreMigrationOwnership($site, $manifest);
    $steps[] = ['command' => 'cutover-rootless-migration', 'label' => 'Restore original ownership', 'display' => 'restore ownership journal and ACLs', 'exitCode' => $restored ? 0 : 1, 'timedOut' => false, 'output' => $restored ? 'Original ownership and ACL access were restored.' : 'Ownership recovery is incomplete; the recovery blocker remains.'];
    if ($restored) {
        $restart = runSiteCommand($site, ['docker', 'compose', '-f', $file, '-p', composeProjectName($site), 'start'], 300, true);
        $steps[] = migrationStep('cutover-rootless-migration', 'Restart legacy rootful project', 'docker compose start', $restart);
        $rollbackVerify = $restart['code'] === 0 && !empty($manifest['expectedPort'])
            ? waitForLoopbackHttp($site, (int) $manifest['expectedPort'])
            : ['code' => 1, 'timedOut' => false, 'stdout' => '', 'stderr' => 'The legacy project did not restart.'];
        $steps[] = migrationStep('cutover-rootless-migration', 'Verify restored website endpoint', 'HTTP probe on the original loopback port', $rollbackVerify);
    }
    $steps[] = [
        'command' => 'cutover-rootless-migration', 'label' => 'Cutover result',
        'display' => 'rootless cutover with automatic rollback', 'exitCode' => 1, 'timedOut' => false,
        'output' => $restored ? 'Rootless cutover failed; the ownership rollback completed. Review the preceding verification steps.' : 'Rootless cutover and ownership rollback are incomplete. Run migration recovery.',
    ];
    return ['steps' => $steps];
}

function recoverRootlessMigration(Site $site): array
{
    $manifest = migrationManifest($site);
    if (!$manifest) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE']);
    $restored = restoreMigrationOwnership($site, $manifest);
    $steps = [['command' => 'recover-rootless-migration', 'label' => 'Restore ownership journal', 'display' => 'restore ownership and ACLs', 'exitCode' => $restored ? 0 : 1, 'timedOut' => false, 'output' => $restored ? 'Ownership recovery completed.' : 'Ownership recovery remains incomplete.']];
    if ($restored) {
        $restart = runSiteCommand($site, ['docker', 'compose', '-f', (string) $manifest['file'], '-p', composeProjectName($site), 'start'], 300, true);
        $steps[] = migrationStep('recover-rootless-migration', 'Restart legacy rootful project', 'docker compose start', $restart);
        $verify = $restart['code'] === 0 && !empty($manifest['expectedPort'])
            ? runSiteCommand($site, ['curl', '--fail', '--silent', '--show-error', '--max-time', '10', 'http://127.0.0.1:' . (int) $manifest['expectedPort'] . '/'], 20, true)
            : ['code' => 1, 'timedOut' => false, 'stdout' => '', 'stderr' => 'The legacy project did not restart.'];
        $steps[] = migrationStep('recover-rootless-migration', 'Verify restored website endpoint', 'HTTP probe on the original loopback port', $verify);
    }
    return ['steps' => $steps];
}

function executeFix(Site $site, string $fix, array &$results): void
{
    switch ($fix) {
        case 'align-application-port':
            alignApplicationPort($site, $results);
            return;
        case 'initialize-rootless-runtime':
            // Site-write self-service: per-user daemon bring-up only. No host
            // package installs or subordinate-range changes ever run here.
            initializeRootlessRuntime($site, $fix, $results);
            return;
        case 'initialize-rootless-docker':
            if (!runFixStep($site, $results, $fix, 'Install rootless prerequisites', ['apt-get', 'install', '-y', 'uidmap', 'dbus-user-session', 'slirp4netns'], 900)) return;
            if (!is_executable('/usr/bin/docker') || !is_executable('/usr/bin/dockerd-rootless-setuptool.sh')) {
                if (!runFixStep($site, $results, $fix, 'Install repository prerequisites', ['apt-get', 'install', '-y', 'ca-certificates', 'curl'], 600)) return;
                if (!configureDockerRepository($site, $fix, $results)) return;
                if (!runFixStep($site, $results, $fix, 'Install Docker rootless runtime', ['apt-get', 'install', '-y', 'docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin', 'docker-ce-rootless-extras'], 900)) return;
            } elseif (!runFixStep($site, $results, $fix, 'Verify Docker rootless packages', ['apt-get', 'install', '-y', 'docker-buildx-plugin', 'docker-compose-plugin', 'docker-ce-rootless-extras'], 900)) return;
            initializeRootlessDocker($site, $fix, $results);
            return;
        case 'install-docker':
            if (!runFixStep($site, $results, $fix, 'Install prerequisites', ['apt-get', 'install', '-y', 'ca-certificates', 'curl'], 600)) return;
            if (!configureDockerRepository($site, $fix, $results)) return;
            if (!runFixStep($site, $results, $fix, 'Install Docker Engine and Compose plugin', ['apt-get', 'install', '-y', 'docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin', 'docker-ce-rootless-extras', 'uidmap', 'dbus-user-session', 'slirp4netns'], 900)) return;
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

// --- Compose port loopback rewrite ------------------------------------------
// Binds a short-syntax published port to 127.0.0.1 without changing the port
// number that the site's reverse proxy targets. Returns the rewritten value,
// or null when the entry is already loopback-bound or in a form Panelavo will
// not rewrite textually (IPv6 host, non-numeric host). The published port is
// never altered — only the host interface it binds to.
function rewriteShortPort(string $value): ?string
{
    $proto = '';
    $core = $value;
    if (($slash = strrpos($value, '/')) !== false) {
        $proto = substr($value, $slash);
        $core = substr($value, 0, $slash);
    }
    if (str_contains($core, '[')) return null; // bracketed IPv6 host — leave to the operator
    $parts = explode(':', $core);
    $loopback = ['127.0.0.1', '::1'];
    if (count($parts) === 3) {
        if (in_array($parts[0], $loopback, true)) return null;
        if ($parts[0] === '' || $parts[0] === '*' || $parts[0] === '0.0.0.0' || $parts[0] === '::'
            || filter_var($parts[0], FILTER_VALIDATE_IP) !== false) {
            $parts[0] = '127.0.0.1';
            return implode(':', $parts) . $proto;
        }
        return null;
    }
    if (count($parts) === 2) {
        return preg_match('/^\d/', $parts[0]) ? '127.0.0.1:' . $core . $proto : null;
    }
    if (count($parts) === 1) {
        return preg_match('/^\d/', $parts[0]) ? '127.0.0.1::' . $core . $proto : null;
    }
    return null;
}

// Line-oriented rewrite that only touches entries inside a `ports:` block, so
// container ports, environment values, and comments are never modified. Short
// list syntax and long-syntax `host_ip:` lines are handled; anything else is
// left untouched and caught by the post-rewrite validation before any change
// is committed.
function rewriteComposePorts(string $text): string
{
    $lines = explode("\n", $text);
    $portsIndent = null;
    $loopback = ['127.0.0.1', '::1'];
    foreach ($lines as $index => $rawLine) {
        $eol = '';
        $line = $rawLine;
        if (str_ends_with($line, "\r")) { $eol = "\r"; $line = substr($line, 0, -1); }
        $indent = strlen($line) - strlen(ltrim($line, ' '));
        $trimmed = trim($line);

        if ($portsIndent !== null && $trimmed !== '' && $indent <= $portsIndent) {
            $portsIndent = null;
        }
        if ($portsIndent === null) {
            if (preg_match('/^(\s*)ports:\s*(#.*)?$/', $line, $m)) $portsIndent = strlen($m[1]);
            continue;
        }
        if ($indent <= $portsIndent) continue;

        if (preg_match('/^(\s*host_ip:\s*)(["\']?)([^"\'#\s]+)\2(\s*(?:#.*)?)$/', $line, $m)) {
            if (!in_array($m[3], $loopback, true)) {
                $lines[$index] = $m[1] . $m[2] . '127.0.0.1' . $m[2] . $m[4] . $eol;
            }
            continue;
        }
        if (preg_match('/^(\s*-\s*)(["\']?)([^"\'#]+?)\2(\s*(?:#.*)?)$/', $line, $m)) {
            $val = trim($m[3]);
            if (preg_match('/^[A-Za-z_]+:\s/', $val)) continue; // long-syntax key line (e.g. "target: 80")
            $rewritten = rewriteShortPort($val);
            if ($rewritten !== null && $rewritten !== $val) {
                $lines[$index] = $m[1] . $m[2] . $rewritten . $m[2] . $m[4] . $eol;
            }
        }
    }
    return implode("\n", $lines);
}

// Changes exactly one literal short-syntax entry mapping. The container port
// and protocol stay intact; only the host-side publication is aligned with
// CloudPanel and restricted to IPv4 loopback. Variables, ranges, flow syntax,
// and duplicate matches are intentionally left for operator instructions.
function rewriteComposeEntryPort(string $text, int $published, int $container, int $expected): ?string
{
    $lines = explode("\n", $text);
    $portsIndent = null;
    $candidates = [];
    foreach ($lines as $index => $rawLine) {
        $eol = '';
        $line = $rawLine;
        if (str_ends_with($line, "\r")) { $eol = "\r"; $line = substr($line, 0, -1); }
        $indent = strlen($line) - strlen(ltrim($line, ' '));
        $trimmed = trim($line);
        if ($portsIndent !== null && $trimmed !== '' && $indent <= $portsIndent) $portsIndent = null;
        if ($portsIndent === null) {
            if (preg_match('/^(\s*)ports:\s*(#.*)?$/', $line, $match)) $portsIndent = strlen($match[1]);
            continue;
        }
        if ($indent <= $portsIndent
            || !preg_match('/^(\s*-\s*)(["\']?)([^"\'#]+?)\2(\s*(?:#.*)?)$/', $line, $match)) continue;
        $value = trim($match[3]);
        $protocol = '';
        if (($slash = strrpos($value, '/')) !== false) {
            $protocol = substr($value, $slash);
            $value = substr($value, 0, $slash);
        }
        if (str_contains($value, '[')) continue;
        $parts = explode(':', $value);
        if (count($parts) === 2) [$host, $source, $target] = ['', $parts[0], $parts[1]];
        elseif (count($parts) === 3) [$host, $source, $target] = $parts;
        else continue;
        if (!ctype_digit($source) || !ctype_digit($target)
            || (int) $source !== $published || (int) $target !== $container) continue;
        $replacement = '127.0.0.1:' . $expected . ':' . $container . $protocol;
        $candidates[] = [$index, $match[1] . $match[2] . $replacement . $match[2] . $match[4] . $eol];
    }
    if (count($candidates) !== 1) return null;
    [$index, $replacement] = $candidates[0];
    $lines[$index] = $replacement;
    return implode("\n", $lines);
}

// Rewrites only one plain numeric PORT assignment while preserving its
// spacing, export prefix, quoting, comments, and every unrelated line.
function rewriteDotenvPort(string $text, int $expected): ?array
{
    $lines = explode("\n", $text);
    $candidates = [];
    foreach ($lines as $index => $rawLine) {
        $eol = '';
        $line = $rawLine;
        if (str_ends_with($line, "\r")) { $eol = "\r"; $line = substr($line, 0, -1); }
        if (!preg_match('/^(\s*(?:export\s+)?PORT\s*=\s*)(["\']?)(\d{1,5})\2(\s*(?:#.*)?)$/', $line, $match)) continue;
        $port = (int) $match[3];
        if ($port < 1 || $port > 65535) return null;
        $candidates[] = [
            'index' => $index,
            'from' => $port,
            'line' => $match[1] . $match[2] . $expected . $match[2] . $match[4] . $eol,
        ];
    }
    if (count($candidates) !== 1) return null;
    $candidate = $candidates[0];
    $lines[$candidate['index']] = $candidate['line'];
    return ['from' => $candidate['from'], 'text' => implode("\n", $lines)];
}

function composeDiffSummary(string $before, string $after): string
{
    $old = explode("\n", $before);
    $new = explode("\n", $after);
    $changes = [];
    foreach ($old as $i => $line) {
        if (($new[$i] ?? null) !== $line) {
            $changes[] = '- ' . trim((string) $line);
            $changes[] = '+ ' . trim((string) ($new[$i] ?? ''));
        }
        if (count($changes) >= 40) { $changes[] = '…'; break; }
    }
    return $changes ? implode("\n", $changes) : '(no line changes)';
}

function portRepairPlanForSite(Site $site): array
{
    $root = siteRootPath($site);
    $composeFile = findComposeFile($root);
    $compose = $composeFile !== null ? composeCapability($site, $root, $composeFile) : null;
    $package = is_file($root . '/package.json') ? json_decode((string) @file_get_contents($root . '/package.json'), true) : null;
    $package = is_array($package) ? $package : null;
    $ecosystem = null;
    foreach (['ecosystem.config.js', 'ecosystem.config.cjs', 'ecosystem.config.json'] as $candidate) {
        if (is_file($root . '/' . $candidate)) { $ecosystem = $candidate; break; }
    }
    $port = sitePortCapability($site, hostListeningPorts($site));
    return portRepairCapability($site, $root, $port, $composeFile, $compose, $package, $ecosystem);
}

function portBackupDirectory(Site $site, bool $create): ?string
{
    $base = PANELAVO_PORT_BACKUP_ROOT;
    $parent = dirname($base);
    if (is_link($parent)) return null;
    if (!is_dir($parent) && (!$create || !@mkdir($parent, 0755, true))) return null;
    $parentReal = realpath($parent);
    $parentStat = @lstat($parent);
    if ($parentReal !== $parent || !is_array($parentStat) || (int) ($parentStat['uid'] ?? -1) !== 0) return null;
    if (is_link($base)) return null;
    if (!is_dir($base) && (!$create || !@mkdir($base, 0700, true))) return null;
    $real = realpath($base);
    $stat = @lstat($base);
    if ($real !== $base || !is_array($stat) || (int) ($stat['uid'] ?? -1) !== 0) return null;
    @chmod($base, 0700);
    $directory = $base . '/' . hash('sha256', strtolower((string) $site->getId() . "\n" . (string) $site->getDomainName()));
    if (is_link($directory)) return null;
    if (!is_dir($directory) && (!$create || !@mkdir($directory, 0700))) return null;
    $real = realpath($directory);
    $stat = @lstat($directory);
    if ($real !== $directory || !is_array($stat) || (int) ($stat['uid'] ?? -1) !== 0) return null;
    @chmod($directory, 0700);
    return $directory;
}

function commitPortSourceRewrite(
    Site $site,
    array &$results,
    string $relative,
    string $path,
    string $staged,
    string $original,
    string $rewritten,
): bool {
    $fix = 'align-application-port';
    if (is_link($path) || !is_file($path) || hash_file('sha256', $path) !== hash('sha256', $original)) {
        @unlink($staged);
        return syntheticFixStep($results, $fix, 'Revalidate source file', 'verify ' . $relative, false,
            'The source file changed while the repair was being prepared. Refresh preflight and try again; no change was made.');
    }
    $backupDirectory = portBackupDirectory($site, true);
    if (!$backupDirectory) {
        @unlink($staged);
        return syntheticFixStep($results, $fix, 'Create protected backup', 'backup ' . $relative, false,
            'The root-owned backup directory could not be prepared; no change was made.');
    }
    $backup = $backupDirectory . '/' . gmdate('Ymd-His') . '-' . hash('sha256', $relative) . '.bak';
    if (file_exists($backup)) $backup .= '-' . bin2hex(random_bytes(3));
    $backupOk = @file_put_contents($backup, $original, LOCK_EX) !== false
        && hash_file('sha256', $backup) === hash('sha256', $original);
    if (!$backupOk) {
        @unlink($backup);
        @unlink($staged);
        return syntheticFixStep($results, $fix, 'Create protected backup', 'backup ' . $relative, false,
            'The source backup could not be verified; no change was made.');
    }
    @chmod($backup, 0600);
    $sourceStat = @lstat($path);
    $prepared = is_array($sourceStat)
        && @chmod($staged, (int) $sourceStat['mode'] & 0777)
        && @chown($staged, (int) $sourceStat['uid'])
        && @chgrp($staged, (int) $sourceStat['gid']);
    if (!$prepared) {
        @unlink($backup);
        @unlink($staged);
        return syntheticFixStep($results, $fix, 'Preserve source ownership', 'prepare ' . $relative, false,
            'The staged file could not preserve the original mode and numeric ownership; the original file was left unchanged.');
    }
    $committed = @rename($staged, $path);
    if (!$committed) {
        @unlink($backup);
        @unlink($staged);
    }
    return syntheticFixStep($results, $fix, 'Save aligned port source', 'edit ' . $relative, $committed,
        $committed
            ? 'Updated ' . $relative . ' after validation. A verified root-owned backup was retained. Restart or deploy the website to apply the new source setting.' . "\n" . composeDiffSummary($original, $rewritten)
            : 'The validated source could not be atomically installed; the original file was left unchanged.');
}

// Site-scoped source repair. It never guesses: the preflight plan and this
// execution pass must independently find the same unique literal setting.
// Compose is resolved and safety-scanned before the staged file replaces the
// source; dotenv rewrites preserve every unrelated byte. No service restarts.
function alignApplicationPort(Site $site, array &$results): void
{
    $fix = 'align-application-port';
    $root = siteRootPath($site);
    $plan = portRepairPlanForSite($site);
    if (empty($plan['canApply']) || !in_array($plan['kind'] ?? null, ['compose', 'dotenv'], true)) {
        syntheticFixStep($results, $fix, 'Revalidate port repair', 'inspect detected port sources', false,
            (string) ($plan['detail'] ?? 'No unambiguous source setting is available.'));
        return;
    }
    $relative = (string) $plan['file'];
    $path = $root . '/' . $relative;
    if (!pathIsContained($path, $root) || is_link($path) || !is_file($path)) {
        syntheticFixStep($results, $fix, 'Revalidate source file', 'verify ' . $relative, false, 'The planned source file is unavailable or unsafe; no change was made.');
        return;
    }
    $original = (string) @file_get_contents($path);
    $expected = (int) $plan['expectedPort'];
    $directoryRelative = dirname($relative) === '.' ? '' : dirname($relative) . '/';
    $stagedRelative = $directoryRelative . '.panelavo-port-check-' . bin2hex(random_bytes(6)) . (($plan['kind'] ?? '') === 'compose' ? '.yaml' : '.env');
    $staged = $root . '/' . $stagedRelative;

    if ($plan['kind'] === 'compose') {
        $rewritten = rewriteComposeEntryPort(
            rewriteComposePorts($original),
            (int) $plan['detectedPort'],
            (int) $plan['containerPort'],
            $expected,
        );
        if (!is_string($rewritten) || $rewritten === $original || @file_put_contents($staged, $rewritten, LOCK_EX) === false) {
            @unlink($staged);
            syntheticFixStep($results, $fix, 'Stage Compose port repair', 'rewrite ' . $relative, false, 'The unique Compose mapping could not be reproduced; no change was made.');
            return;
        }
        @chown($staged, $site->getUser()); @chgrp($staged, $site->getUser());
        $config = runRootlessDockerCommand($site, ['docker', 'compose', '-f', $stagedRelative, '-p', composeProjectName($site), 'config', '--format', 'json'], 60, $root);
        $parsed = $config['code'] === 0 ? json_decode($config['stdout'], true) : null;
        $routing = is_array($parsed) ? composePortRouting($expected, $parsed) : [];
        $safety = is_array($parsed) ? composeSafetyScan($parsed, $root) : ['safe' => false];
        $valid = $config['code'] === 0 && !empty($routing['portMatches']) && !empty($safety['safe']);
        syntheticFixStep($results, $fix, 'Validate aligned Compose', 'docker compose config and host-safety scan', $valid,
            $valid ? 'The staged source resolves to the CloudPanel port on loopback and passes the host-safety policy.' : 'The staged Compose source did not resolve to one safe matching loopback entry. No change was made.');
        if (!$valid) { @unlink($staged); return; }
        commitPortSourceRewrite($site, $results, $relative, $path, $staged, $original, $rewritten);
        return;
    }

    $dotenv = rewriteDotenvPort($original, $expected);
    $rewritten = is_array($dotenv) ? (string) $dotenv['text'] : '';
    $valid = $rewritten !== '' && (parseEnvContent($rewritten)['PORT'] ?? null) === (string) $expected;
    if (!$valid || @file_put_contents($staged, $rewritten, LOCK_EX) === false) {
        @unlink($staged);
        syntheticFixStep($results, $fix, 'Stage .env port repair', 'rewrite .env PORT', false, 'The unique .env PORT assignment could not be reproduced; no change was made.');
        return;
    }
    syntheticFixStep($results, $fix, 'Validate aligned .env', 'parse .env PORT', true, 'The staged .env contains exactly one numeric PORT matching CloudPanel.');
    commitPortSourceRewrite($site, $results, $relative, $path, $staged, $original, $rewritten);
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
    $byPid = [];
    foreach ($procB as $pid => [$uid, $t]) {
        if (!isset($procA[$pid])) continue;
        $delta = $t - $procA[$pid][1];
        if ($delta <= 0) continue;
        $percent = $delta / $hertz / $elapsed * 100;
        $byPid[$pid] = round($percent, 1);
        $byUid[$uid] = ($byUid[$uid] ?? 0) + $delta;
    }
    $byUser = [];
    foreach ($byUid as $uid => $ticksDelta) {
        $name = function_exists('posix_getpwuid')
            ? ((posix_getpwuid($uid)['name'] ?? null) ?: (string) $uid)
            : (string) $uid;
        // Single-core units (100 = one full core), matching capacity cores×100.
        $byUser[$name] = round($ticksDelta / $hertz / $elapsed * 100, 1);
    }
    return ['usedPercent' => $usedPercent, 'byUser' => $byUser, 'byPid' => $byPid];
}

function resourceCommand(array $args, int $seconds = 3): array
{
    $command = array_merge(['/usr/bin/timeout', '--signal=KILL', (string) $seconds], $args);
    $process = @proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($process)) return ['code' => -1, 'stdout' => '', 'stderr' => ''];
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]); fclose($pipes[1]);
    $stderr = stream_get_contents($pipes[2]); fclose($pipes[2]);
    return ['code' => proc_close($process), 'stdout' => $stdout ?: '', 'stderr' => $stderr ?: ''];
}

function resourceFilesystemUsage(): array
{
    $df = is_executable('/usr/bin/df') ? '/usr/bin/df' : '/bin/df';
    $result = resourceCommand([$df, '-B1', '--output=size,used,avail,target', '/'], 3);
    $lines = array_values(array_filter(preg_split('/\R/', trim($result['stdout'])) ?: []));
    $line = $lines ? end($lines) : '';
    if (is_string($line) && preg_match('/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/', $line, $match)) {
        $total = (int) $match[1];
        $used = (int) $match[2];
        $available = (int) $match[3];
        return [
            'totalBytes' => $total,
            'usedBytes' => $used,
            'availableBytes' => $available,
            'reservedBytes' => max(0, $total - $used - $available),
            'mount' => trim($match[4]),
        ];
    }
    $total = (int) disk_total_space('/');
    $available = (int) disk_free_space('/');
    return [
        'totalBytes' => $total,
        'usedBytes' => max(0, $total - $available),
        'availableBytes' => $available,
        'reservedBytes' => 0,
        'mount' => '/',
    ];
}

// --- Database gateway --------------------------------------------------------
// CloudPanel remains authoritative for databases and database users. Panelavo
// stores only the public endpoint mapping under a root-owned directory. Each
// endpoint receives a dedicated CloudPanel user whose grants cover one schema;
// the main MySQL listener never needs to be public.

function databaseGatewayState(): array
{
    $fallback = [
        'version' => 1,
        'enabled' => false,
        'suffix' => '',
        'publicPortStart' => 43000,
        'proxyPortStart' => 44000,
        'slots' => 256,
        'tlsTrust' => 'panelavo-ca',
        'endpoints' => [],
    ];
    $value = json_decode((string) @file_get_contents(PANELAVO_DATABASE_GATEWAY_STATE), true);
    if (!is_array($value)) return $fallback;
    $value = array_replace($fallback, $value);
    $value['endpoints'] = is_array($value['endpoints'] ?? null) ? $value['endpoints'] : [];
    return $value;
}

function saveDatabaseGatewayState(array $state): void
{
    if (!is_dir(PANELAVO_DATABASE_GATEWAY_ROOT)
        && !mkdir(PANELAVO_DATABASE_GATEWAY_ROOT, 0700, true)) {
        throw new RuntimeException('The database gateway state directory could not be created.');
    }
    $temporary = PANELAVO_DATABASE_GATEWAY_STATE . '.tmp-' . bin2hex(random_bytes(6));
    $encoded = json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    if (file_put_contents($temporary, $encoded) === false) throw new RuntimeException('The database gateway state could not be written.');
    chmod($temporary, 0600);
    if (!rename($temporary, PANELAVO_DATABASE_GATEWAY_STATE)) {
        @unlink($temporary);
        throw new RuntimeException('The database gateway state could not be activated.');
    }
}

function databaseGatewayReady(array $state): bool
{
    if (($state['enabled'] ?? false) !== true) return false;
    if (!preg_match('/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/', (string) ($state['suffix'] ?? ''))) return false;
    if (!is_readable(PANELAVO_DATABASE_GATEWAY_ADMIN)) return false;
    if (!is_executable('/usr/bin/proxysql') || !is_executable('/usr/sbin/nginx')) return false;
    foreach (['proxysql-ca.pem', 'proxysql-cert.pem', 'proxysql-key.pem'] as $file) {
        if (!is_readable(PANELAVO_DATABASE_GATEWAY_ROOT . '/proxysql/' . $file)) return false;
    }
    return true;
}

function databaseGatewayServiceReady(): bool
{
    foreach (['panelavo-database-gateway.service', 'nginx.service'] as $service) {
        $result = resourceCommand(['/usr/bin/systemctl', 'is-active', '--quiet', $service], 5);
        if ($result['code'] !== 0) return false;
    }
    try {
        $pdo = databaseGatewayAdmin();
        $status = $pdo->query('SELECT status FROM runtime_mysql_servers WHERE hostgroup_id=10 AND hostname=\'127.0.0.1\' AND port=3306 LIMIT 1')?->fetchColumn();
        return is_string($status) && strtoupper($status) === 'ONLINE';
    } catch (Throwable) {
        return false;
    }
}

function databaseGatewayDatabase(Site $site, string $name)
{
    foreach ($site->getDatabases()->toArray() as $database) {
        if ((string) $database->getName() === $name) return $database;
    }
    return null;
}

function databaseGatewayUser($database, string $username)
{
    foreach ($database->getUsers()->toArray() as $candidate) {
        if ((string) $candidate->getUserName() === $username) return $candidate;
    }
    return null;
}

function databaseGatewayCidr(string $value): ?string
{
    $value = trim($value);
    $parts = explode('/', $value, 2);
    $ip = $parts[0] ?? '';
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        $prefix = isset($parts[1]) ? filter_var($parts[1], FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 32]]) : 32;
    } elseif (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
        $prefix = isset($parts[1]) ? filter_var($parts[1], FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 128]]) : 128;
    } else return null;
    if ($prefix === false) return null;
    return strtolower($ip) . '/' . $prefix;
}

function databaseGatewayAllowlist($input, string $mode): array
{
    if (!is_array($input) || count($input) > 32) invalidBrokerRequest();
    $values = [];
    foreach ($input as $value) {
        if (!is_string($value)) invalidBrokerRequest();
        $cidr = databaseGatewayCidr($value);
        if ($cidr === null) invalidBrokerRequest();
        $values[] = $cidr;
    }
    $values = array_values(array_unique($values));
    if ($mode === 'allowlist' && !$values) invalidBrokerRequest();
    if ($mode === 'internet' && $values) invalidBrokerRequest();
    return $values;
}

function databaseGatewayLabel($input): string
{
    $label = strtolower(trim((string) $input));
    if (!preg_match('/^(?!-)[a-z0-9-]{3,40}(?<!-)$/', $label)) invalidBrokerRequest();
    return $label;
}

function databaseGatewayHostname(array $state, string $label): string
{
    return 'db-' . $label . '.' . strtolower((string) $state['suffix']);
}

function databaseGatewayAdmin(): PDO
{
    $raw = trim((string) @file_get_contents(PANELAVO_DATABASE_GATEWAY_ADMIN));
    [$username, $password] = array_pad(explode(':', $raw, 2), 2, '');
    if (!preg_match('/^[A-Za-z0-9_-]{8,64}$/', $username) || strlen($password) < 24) {
        throw new RuntimeException('The database gateway administrator credential is invalid.');
    }
    return new PDO('mysql:host=127.0.0.1;port=16032;dbname=main', $username, $password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_TIMEOUT => 5,
        PDO::ATTR_EMULATE_PREPARES => true,
    ]);
}

function databaseGatewayPasswordHash(string $password): string
{
    return '*' . strtoupper(sha1(sha1($password, true)));
}

function databaseGatewayRuleIds(int $slot): array
{
    return [200000 + $slot * 2, 200001 + $slot * 2];
}

function configureDatabaseGatewayProxy(array $endpoint, string $password): void
{
    $pdo = databaseGatewayAdmin();
    $username = (string) $endpoint['username'];
    $database = (string) $endpoint['databaseName'];
    $proxyPort = (int) $endpoint['proxyPort'];
    $slot = (int) $endpoint['slot'];
    [$allowRule, $denyRule] = databaseGatewayRuleIds($slot);
    $qUser = $pdo->quote($username);
    $qDatabase = $pdo->quote($database);
    $qPassword = $pdo->quote(databaseGatewayPasswordHash($password));
    $comment = $pdo->quote('panelavo database endpoint ' . (string) $endpoint['hostname']);
    $pdo->exec('DELETE FROM mysql_users WHERE username = ' . $qUser);
    $pdo->exec("INSERT INTO mysql_users (username,password,active,use_ssl,default_hostgroup,default_schema,schema_locked,transaction_persistent,fast_forward,backend,frontend,max_connections,attributes,comment) VALUES ({$qUser},{$qPassword},1,1,10,{$qDatabase},1,1,0,1,1,20,'',{$comment})");
    $pdo->exec('DELETE FROM mysql_query_rules WHERE rule_id IN (' . $allowRule . ',' . $denyRule . ') OR comment = ' . $comment);
    $pdo->exec("INSERT INTO mysql_query_rules (rule_id,active,username,proxy_port,match_digest,destination_hostgroup,apply,comment) VALUES ({$allowRule},1,{$qUser},{$proxyPort},'.*',10,1,{$comment})");
    $pdo->exec("INSERT INTO mysql_query_rules (rule_id,active,username,match_digest,error_msg,apply,comment) VALUES ({$denyRule},1,{$qUser},'.*','This database credential is not valid on that endpoint.',1,{$comment})");
    $pdo->exec('LOAD MYSQL USERS TO RUNTIME');
    $pdo->exec('SAVE MYSQL USERS TO DISK');
    $pdo->exec('LOAD MYSQL QUERY RULES TO RUNTIME');
    $pdo->exec('SAVE MYSQL QUERY RULES TO DISK');
}

function removeDatabaseGatewayProxy(array $endpoint): void
{
    $pdo = databaseGatewayAdmin();
    $qUser = $pdo->quote((string) $endpoint['username']);
    [$allowRule, $denyRule] = databaseGatewayRuleIds((int) $endpoint['slot']);
    try {
        $rows = $pdo->query('SELECT SessionID FROM stats_mysql_processlist WHERE user = ' . $qUser)?->fetchAll(PDO::FETCH_COLUMN) ?: [];
        foreach ($rows as $sessionId) if (is_numeric($sessionId)) {
            try { $pdo->exec('KILL CONNECTION ' . (int) $sessionId); } catch (Throwable) {}
        }
    } catch (Throwable) {}
    $pdo->exec('DELETE FROM mysql_users WHERE username = ' . $qUser);
    $pdo->exec('DELETE FROM mysql_query_rules WHERE rule_id IN (' . $allowRule . ',' . $denyRule . ')');
    $pdo->exec('LOAD MYSQL USERS TO RUNTIME');
    $pdo->exec('SAVE MYSQL USERS TO DISK');
    $pdo->exec('LOAD MYSQL QUERY RULES TO RUNTIME');
    $pdo->exec('SAVE MYSQL QUERY RULES TO DISK');
}

function writeDatabaseGatewayStream(array $endpoint, bool $enabled): void
{
    if (!is_dir(PANELAVO_DATABASE_GATEWAY_STREAMS)
        && !mkdir(PANELAVO_DATABASE_GATEWAY_STREAMS, 0755, true)) {
        throw new RuntimeException('The Nginx database gateway directory could not be created.');
    }
    $slot = (int) $endpoint['slot'];
    $path = PANELAVO_DATABASE_GATEWAY_STREAMS . '/database-' . $slot . '.conf';
    if (is_link($path)) throw new RuntimeException('The database endpoint configuration is unsafe.');
    $previous = is_file($path) ? (string) file_get_contents($path) : null;
    if ($enabled) {
        $publicPort = (int) $endpoint['port'];
        $proxyPort = (int) $endpoint['proxyPort'];
        $access = '';
        if (($endpoint['accessMode'] ?? '') === 'allowlist') {
            foreach ((array) ($endpoint['allowlist'] ?? []) as $cidr) $access .= '        allow ' . $cidr . ";\n";
            $access .= "        deny all;\n";
        }
        $content = "# Managed by Panelavo. Do not edit.\n"
            . "server {\n"
            . "        listen {$publicPort};\n"
            . "        listen [::]:{$publicPort};\n"
            . "        proxy_connect_timeout 10s;\n"
            . "        proxy_timeout 10m;\n"
            . "        proxy_protocol on;\n"
            . "        proxy_pass 127.0.0.1:{$proxyPort};\n"
            . "        limit_conn panelavo_database_per_ip 20;\n"
            . "        access_log /var/log/nginx/panelavo-database-gateway.log panelavo_database;\n"
            . $access
            . "}\n";
        $temporary = $path . '.tmp-' . bin2hex(random_bytes(4));
        if (file_put_contents($temporary, $content) === false || !rename($temporary, $path)) {
            @unlink($temporary);
            throw new RuntimeException('The database endpoint configuration could not be written.');
        }
        chmod($path, 0644);
    } else @unlink($path);
    $test = resourceCommand(['/usr/sbin/nginx', '-t'], 15);
    if ($test['code'] !== 0) {
        if ($previous === null) @unlink($path); else file_put_contents($path, $previous);
        throw new RuntimeException('Nginx rejected the database endpoint configuration.');
    }
    $reload = resourceCommand(['/usr/bin/systemctl', 'reload', 'nginx'], 15);
    if ($reload['code'] !== 0) {
        if ($previous === null) @unlink($path); else file_put_contents($path, $previous);
        resourceCommand(['/usr/bin/systemctl', 'reload', 'nginx'], 15);
        throw new RuntimeException('Nginx could not activate the database endpoint configuration.');
    }
}

function publicDatabaseGatewayEndpoint(array $state, ?array $endpoint, bool $serviceReady): array
{
    if (!$endpoint) return ['status' => 'private'];
    $ready = ($endpoint['status'] ?? '') === 'public'
        && $serviceReady
        && is_file(PANELAVO_DATABASE_GATEWAY_STREAMS . '/database-' . (int) $endpoint['slot'] . '.conf');
    return [
        'status' => $ready ? 'public' : (($endpoint['status'] ?? '') === 'provisioning' ? 'provisioning' : 'degraded'),
        'hostname' => (string) ($endpoint['hostname'] ?? ''),
        'port' => (int) ($endpoint['port'] ?? 0),
        'username' => (string) ($endpoint['username'] ?? ''),
        'permissions' => (string) ($endpoint['permissions'] ?? 'ro'),
        'accessMode' => (string) ($endpoint['accessMode'] ?? 'allowlist'),
        'allowlist' => array_values((array) ($endpoint['allowlist'] ?? [])),
        'tlsTrust' => (string) ($state['tlsTrust'] ?? 'panelavo-ca'),
        'createdAt' => (string) ($endpoint['createdAt'] ?? ''),
        'verifiedAt' => (string) ($endpoint['verifiedAt'] ?? ''),
        ...(!$ready ? ['message' => 'The endpoint is fail-closed until its gateway configuration is healthy.'] : []),
    ];
}

function databaseGatewaySection(Site $site): array
{
    $state = databaseGatewayState();
    $serviceReady = databaseGatewayReady($state) && databaseGatewayServiceReady();
    $items = [];
    foreach ($site->getDatabases()->toArray() as $database) {
        $key = (string) $database->getId();
        $endpoint = is_array($state['endpoints'][$key] ?? null) ? $state['endpoints'][$key] : null;
        $remoteUsername = (string) ($endpoint['username'] ?? '');
        $items[] = [
            'id' => $key,
            'name' => $database->getName(),
            'users' => array_values(array_map(
                static fn($candidate) => (string) $candidate->getUserName(),
                array_filter($database->getUsers()->toArray(), static fn($candidate) => (string) $candidate->getUserName() !== $remoteUsername),
            )),
            'createdAt' => $database->getCreatedAt()?->format(DATE_ATOM),
            'exposure' => publicDatabaseGatewayEndpoint($state, $endpoint, $serviceReady),
        ];
    }
    return [
        'items' => $items,
        'gateway' => [
            'ready' => $serviceReady,
            'suffix' => (string) ($state['suffix'] ?? ''),
            'tlsTrust' => (string) ($state['tlsTrust'] ?? 'panelavo-ca'),
            'caAvailable' => is_readable(PANELAVO_DATABASE_GATEWAY_ROOT . '/proxysql/proxysql-ca.pem'),
            'capacity' => (int) ($state['slots'] ?? 0),
            'active' => count((array) ($state['endpoints'] ?? [])),
        ],
    ];
}

function databaseGatewaySlot(array $state): int
{
    $used = [];
    foreach ((array) $state['endpoints'] as $endpoint) if (is_array($endpoint)) $used[(int) ($endpoint['slot'] ?? -1)] = true;
    $slots = max(1, min(256, (int) ($state['slots'] ?? 256)));
    for ($slot = 0; $slot < $slots; $slot++) if (!isset($used[$slot])) return $slot;
    throw new RuntimeException('This server has no free database endpoint slots.');
}

function databaseGatewayRandomPassword(): string
{
    return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
}

function revokeDatabaseGatewayEndpoint($manager, $database, array $endpoint, array &$state): void
{
    try { writeDatabaseGatewayStream($endpoint, false); } catch (Throwable) {
        throw new RuntimeException('The database endpoint could not be closed safely.');
    }
    // The public Stream listener is already gone. If ProxySQL itself is down,
    // deleting the authoritative database user still invalidates its backend
    // credential and keeps revocation available during gateway recovery.
    try { removeDatabaseGatewayProxy($endpoint); } catch (Throwable) {}
    $databaseUser = databaseGatewayUser($database, (string) $endpoint['username']);
    if ($databaseUser instanceof DatabaseUser) {
        $databaseManager = new DatabaseManager($database->getDatabaseServer());
        $databaseManager->deleteUser($databaseUser);
        $database->removeUser($databaseUser);
        $manager->remove($databaseUser);
        $manager->flush();
    }
    unset($state['endpoints'][(string) $database->getId()]);
    saveDatabaseGatewayState($state);
}

function manageDatabaseGateway($manager, Site $site, array $operation): array
{
    $state = databaseGatewayState();
    $gatewayReady = databaseGatewayReady($state) && databaseGatewayServiceReady();
    $databaseName = brokerString($operation, 'name', 2, 50, '/^[A-Za-z][A-Za-z0-9-]+$/');
    $database = databaseGatewayDatabase($site, $databaseName);
    if (!$database) throw new RuntimeException('That database does not belong to this website.');
    $key = (string) $database->getId();
    $existing = is_array($state['endpoints'][$key] ?? null) ? $state['endpoints'][$key] : null;
    $action = (string) ($operation['action'] ?? '');
    if ($action === 'exposure-create') {
        if (!$gatewayReady) throw new RuntimeException('The private database gateway is not ready on this server. Run trusted setup first.');
        if ($existing) throw new RuntimeException('This database already has a public endpoint.');
        $label = databaseGatewayLabel($operation['label'] ?? null);
        $hostname = databaseGatewayHostname($state, $label);
        if (!hash_equals($hostname, strtolower(trim((string) ($operation['confirmation'] ?? ''))))) invalidBrokerRequest();
        foreach ((array) $state['endpoints'] as $candidate) if (is_array($candidate) && ($candidate['hostname'] ?? null) === $hostname) {
            throw new RuntimeException('That database endpoint hostname is already in use.');
        }
        $permissions = (string) ($operation['permissions'] ?? 'ro');
        if (!in_array($permissions, ['ro', 'rw'], true)) invalidBrokerRequest();
        $accessMode = (string) ($operation['accessMode'] ?? 'allowlist');
        if (!in_array($accessMode, ['allowlist', 'internet'], true)) invalidBrokerRequest();
        $allowlist = databaseGatewayAllowlist($operation['allowlist'] ?? [], $accessMode);
        $slot = databaseGatewaySlot($state);
        do {
            $username = 'pa-' . $database->getId() . '-' . bin2hex(random_bytes(4));
        } while ($manager->getRepository(DatabaseUser::class)->findOneBy(['userName' => $username]));
        $password = databaseGatewayRandomPassword();
        $endpoint = [
            'status' => 'provisioning',
            'slot' => $slot,
            'siteDomain' => (string) $site->getDomainName(),
            'databaseId' => (int) $database->getId(),
            'databaseName' => (string) $database->getName(),
            'label' => $label,
            'hostname' => $hostname,
            'port' => (int) $state['publicPortStart'] + $slot,
            'proxyPort' => (int) $state['proxyPortStart'] + $slot,
            'username' => $username,
            'permissions' => $permissions,
            'accessMode' => $accessMode,
            'allowlist' => $allowlist,
            'createdAt' => gmdate(DATE_ATOM),
        ];
        $state['endpoints'][$key] = $endpoint;
        saveDatabaseGatewayState($state);
        $databaseUser = new DatabaseUser();
        $databaseUser->setDatabase($database);
        $databaseUser->setUserName($username);
        $databaseUser->setPassword(Crypto::encrypt($password));
        $databaseUser->setPermissions($permissions === 'ro' ? DatabaseUser::PERMISSIONS_READ_ONLY : DatabaseUser::PERMISSIONS_READ_WRITE);
        $database->addUser($databaseUser);
        try {
            (new DatabaseManager($database->getDatabaseServer()))->createUser($databaseUser);
            $manager->persist($databaseUser);
            $manager->flush();
            configureDatabaseGatewayProxy($endpoint, $password);
            writeDatabaseGatewayStream($endpoint, true);
            $endpoint['status'] = 'public';
            $endpoint['verifiedAt'] = gmdate(DATE_ATOM);
            $state['endpoints'][$key] = $endpoint;
            saveDatabaseGatewayState($state);
            return ['endpoint' => publicDatabaseGatewayEndpoint($state, $endpoint, true), 'password' => $password];
        } catch (Throwable $error) {
            try { writeDatabaseGatewayStream($endpoint, false); } catch (Throwable) {}
            try { removeDatabaseGatewayProxy($endpoint); } catch (Throwable) {}
            try {
                (new DatabaseManager($database->getDatabaseServer()))->deleteUser($databaseUser);
                $database->removeUser($databaseUser);
                $manager->remove($databaseUser);
                $manager->flush();
            } catch (Throwable) {}
            unset($state['endpoints'][$key]);
            saveDatabaseGatewayState($state);
            throw new RuntimeException('The database endpoint could not be provisioned; every partial public component was removed.', 0, $error);
        }
    }
    if (!$existing) throw new RuntimeException('This database is already private.');
    if (!hash_equals((string) $existing['hostname'], strtolower(trim((string) ($operation['confirmation'] ?? ''))))) invalidBrokerRequest();
    if ($action === 'exposure-revoke') {
        revokeDatabaseGatewayEndpoint($manager, $database, $existing, $state);
        return ['endpoint' => ['status' => 'private']];
    }
    if (!$gatewayReady) throw new RuntimeException('The database gateway is unavailable. The endpoint remains fail-closed; restore the gateway before changing or rotating it.');
    $databaseUser = databaseGatewayUser($database, (string) $existing['username']);
    if (!$databaseUser instanceof DatabaseUser) throw new RuntimeException('The endpoint credential is missing; the endpoint remains fail-closed.');
    if ($action === 'exposure-rotate') {
        $oldPassword = (string) $databaseUser->getDecryptedPassword();
        $newPassword = databaseGatewayRandomPassword();
        try {
            $databaseUser->setPassword(Crypto::encrypt($newPassword));
            (new DatabaseManager($database->getDatabaseServer()))->createUser($databaseUser);
            $manager->flush();
            configureDatabaseGatewayProxy($existing, $newPassword);
            return ['endpoint' => publicDatabaseGatewayEndpoint($state, $existing, true), 'password' => $newPassword];
        } catch (Throwable $error) {
            $databaseUser->setPassword(Crypto::encrypt($oldPassword));
            try {
                (new DatabaseManager($database->getDatabaseServer()))->createUser($databaseUser);
                $manager->flush();
                configureDatabaseGatewayProxy($existing, $oldPassword);
            } catch (Throwable) {}
            throw new RuntimeException('The endpoint credential rotation failed and the previous credential was restored.', 0, $error);
        }
    }
    if ($action === 'exposure-update') {
        $permissions = (string) ($operation['permissions'] ?? $existing['permissions']);
        if (!in_array($permissions, ['ro', 'rw'], true)) invalidBrokerRequest();
        $accessMode = (string) ($operation['accessMode'] ?? $existing['accessMode']);
        if (!in_array($accessMode, ['allowlist', 'internet'], true)) invalidBrokerRequest();
        $allowlist = databaseGatewayAllowlist($operation['allowlist'] ?? [], $accessMode);
        $updated = $existing;
        $updated['permissions'] = $permissions;
        $updated['accessMode'] = $accessMode;
        $updated['allowlist'] = $allowlist;
        $oldEntityPermissions = (string) $databaseUser->getPermissions();
        try {
            if ($permissions !== ($existing['permissions'] ?? 'ro')) {
                $databaseUser->setPermissions($permissions === 'ro' ? DatabaseUser::PERMISSIONS_READ_ONLY : DatabaseUser::PERMISSIONS_READ_WRITE);
                (new DatabaseManager($database->getDatabaseServer()))->createUser($databaseUser);
                $manager->flush();
            }
            writeDatabaseGatewayStream($updated, true);
            try {
                $pdo = databaseGatewayAdmin();
                $qUser = $pdo->quote((string) $existing['username']);
                $rows = $pdo->query('SELECT SessionID FROM stats_mysql_processlist WHERE user = ' . $qUser)?->fetchAll(PDO::FETCH_COLUMN) ?: [];
                foreach ($rows as $sessionId) if (is_numeric($sessionId)) try { $pdo->exec('KILL CONNECTION ' . (int) $sessionId); } catch (Throwable) {}
            } catch (Throwable) {}
            $updated['verifiedAt'] = gmdate(DATE_ATOM);
            $state['endpoints'][$key] = $updated;
            saveDatabaseGatewayState($state);
            return ['endpoint' => publicDatabaseGatewayEndpoint($state, $updated, true)];
        } catch (Throwable $error) {
            try {
                $databaseUser->setPermissions($oldEntityPermissions);
                (new DatabaseManager($database->getDatabaseServer()))->createUser($databaseUser);
                $manager->flush();
                writeDatabaseGatewayStream($existing, true);
            } catch (Throwable) {
                try { writeDatabaseGatewayStream($existing, false); } catch (Throwable) {}
            }
            throw new RuntimeException('The endpoint update failed; its previous policy was restored or the endpoint was closed.', 0, $error);
        }
    }
    invalidBrokerRequest();
}

function reconcileDatabaseGateway($manager): array
{
    $state = databaseGatewayState();
    if (!databaseGatewayReady($state) || !databaseGatewayServiceReady()) return ['ready' => false, 'checkedAt' => gmdate(DATE_ATOM), 'repaired' => 0, 'degraded' => count((array) $state['endpoints'])];
    $repaired = 0;
    $degraded = 0;
    foreach ((array) $state['endpoints'] as $key => $endpoint) {
        if (!is_array($endpoint)) { unset($state['endpoints'][$key]); continue; }
        $site = $manager->getRepository(Site::class)->findOneBy(['domainName' => (string) ($endpoint['siteDomain'] ?? '')]);
        $database = $site instanceof Site ? databaseGatewayDatabase($site, (string) ($endpoint['databaseName'] ?? '')) : null;
        $databaseUser = $database ? databaseGatewayUser($database, (string) ($endpoint['username'] ?? '')) : null;
        if (!$site || !$database || !$databaseUser instanceof DatabaseUser) {
            try { writeDatabaseGatewayStream($endpoint, false); } catch (Throwable) {}
            try { removeDatabaseGatewayProxy($endpoint); } catch (Throwable) {}
            unset($state['endpoints'][$key]);
            $repaired++;
            continue;
        }
        try {
            configureDatabaseGatewayProxy($endpoint, (string) $databaseUser->getDecryptedPassword());
            writeDatabaseGatewayStream($endpoint, true);
            $state['endpoints'][$key]['status'] = 'public';
            $state['endpoints'][$key]['verifiedAt'] = gmdate(DATE_ATOM);
            $repaired++;
        } catch (Throwable) {
            try { writeDatabaseGatewayStream($endpoint, false); } catch (Throwable) {}
            $state['endpoints'][$key]['status'] = 'degraded';
            $degraded++;
        }
    }
    saveDatabaseGatewayState($state);
    return ['ready' => $degraded === 0, 'checkedAt' => gmdate(DATE_ATOM), 'repaired' => $repaired, 'degraded' => $degraded];
}

function resourceDirectoryUsage(array $paths, int $seconds = 240): array
{
    $du = is_executable('/usr/bin/du') ? '/usr/bin/du' : '/bin/du';
    $timeout = is_executable('/usr/bin/timeout') ? '/usr/bin/timeout' : '/bin/timeout';
    $paths = array_values(array_unique(array_filter($paths, static fn($path) => is_string($path) && (is_dir($path) || is_file($path)))));
    $processes = [];
    foreach (array_slice($paths, 0, 32) as $path) {
        $command = [$timeout, '--signal=KILL', (string) $seconds];
        if (is_executable('/usr/bin/nice')) array_push($command, '/usr/bin/nice', '-n', '15');
        if (is_executable('/usr/bin/ionice')) array_push($command, '/usr/bin/ionice', '-c', '3');
        array_push($command, $du, '-x', '-B1', '-s', '--', $path);
        $process = @proc_open(
            $command,
            [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'a']],
            $pipes,
        );
        if (is_resource($process)) $processes[$path] = ['process' => $process, 'stdout' => $pipes[1]];
    }
    $usage = [];
    foreach ($processes as $path => $running) {
        $stdout = stream_get_contents($running['stdout']);
        fclose($running['stdout']);
        proc_close($running['process']);
        if (is_string($stdout) && preg_match('/^(\d+)\s+/', trim($stdout), $match)) $usage[$path] = (int) $match[1];
    }
    return $usage;
}

function resourceRootPath(string $path): ?string
{
    if (!file_exists($path) || is_link($path)) return null;
    $rootStat = @stat('/');
    $pathStat = @stat($path);
    if (!is_array($rootStat) || !is_array($pathStat) || ($rootStat['dev'] ?? null) !== ($pathStat['dev'] ?? null)) return null;
    return $path;
}

function resourceRootlessDockerCommand(string $user, array $arguments, int $seconds): ?array
{
    if (!preg_match('/^[A-Za-z0-9._-]{1,64}$/', $user)) return null;
    $account = function_exists('posix_getpwnam') ? posix_getpwnam($user) : false;
    $uid = is_array($account) ? (int) ($account['uid'] ?? 0) : 0;
    $socket = $uid > 0 ? '/run/user/' . $uid . '/docker.sock' : '';
    $docker = is_executable('/usr/bin/docker') ? '/usr/bin/docker' : (is_executable('/usr/local/bin/docker') ? '/usr/local/bin/docker' : null);
    if (!$docker || !$socket || !pathIsSocket($socket)) return null;
    $home = '/home/' . $user;
    return resourceCommand(array_merge([
        '/usr/bin/sudo', '-n', '-u', $user, '--',
        '/usr/bin/env', '-i',
        'PATH=/usr/local/bin:/usr/bin:/bin',
        'HOME=' . $home,
        'USER=' . $user,
        'LOGNAME=' . $user,
        'XDG_RUNTIME_DIR=/run/user/' . $uid,
        'DOCKER_HOST=unix://' . $socket,
        $docker,
    ], $arguments), $seconds);
}

function resourceRootlessDockerMetrics(string $user): array
{
    $result = resourceRootlessDockerCommand($user, ['system', 'df', '--format', '{{json .}}'], 8);
    if ($result === null) return [];
    $metrics = [];
    foreach (preg_split('/\R/', trim($result['stdout'])) ?: [] as $line) {
        $row = json_decode($line, true);
        if (!is_array($row) || !is_string($row['Type'] ?? null) || !is_string($row['Size'] ?? null)) continue;
        $metrics[] = [
            'label' => (string) $row['Type'],
            'value' => (string) $row['Size'],
            'reclaimable' => is_string($row['Reclaimable'] ?? null) ? (string) $row['Reclaimable'] : null,
        ];
    }
    return $metrics;
}

function reclaimServerBuildCache($manager): array
{
    $directory = '/var/lib/panelavo';
    if (!is_dir($directory)) @mkdir($directory, 0700, true);
    $lock = @fopen($directory . '/storage-cleanup.lock', 'c');
    if (!is_resource($lock) || !flock($lock, LOCK_EX | LOCK_NB)) {
        if (is_resource($lock)) fclose($lock);
        respond(['ok' => false, 'code' => 'BUSY', 'message' => 'Another safe storage cleanup is already running.']);
    }
    @chmod($directory . '/storage-cleanup.lock', 0600);

    $retainedBytes = 5000000000;
    $before = resourceFilesystemUsage();
    $siteUsers = [];
    foreach (resourceSites($manager) as $site) {
        $user = (string) $site['user'];
        if (!preg_match('/^[A-Za-z0-9._-]{1,64}$/', $user)) continue;
        $siteUsers[$user][] = (string) $site['domain'];
    }
    ksort($siteUsers);
    $sites = [];
    foreach ($siteUsers as $user => $domains) {
        $help = resourceRootlessDockerCommand($user, ['builder', 'prune', '--help'], 8);
        if ($help === null) {
            $sites[] = ['user' => $user, 'domains' => array_values(array_unique($domains)), 'status' => 'skipped', 'reclaimed' => '0B', 'message' => 'The private Docker daemon is not running.'];
            continue;
        }
        if ($help['code'] !== 0 || !str_contains($help['stdout'], '--max-used-space')) {
            $sites[] = ['user' => $user, 'domains' => array_values(array_unique($domains)), 'status' => 'skipped', 'reclaimed' => '0B', 'message' => 'This Docker version does not support bounded build-cache cleanup.'];
            continue;
        }
        $result = resourceRootlessDockerCommand($user, [
            'builder', 'prune', '--all', '--force', '--max-used-space', (string) $retainedBytes,
        ], 600);
        if ($result === null || $result['code'] !== 0) {
            $detail = trim((string) (($result['stderr'] ?? '') !== '' ? $result['stderr'] : ($result['stdout'] ?? '')));
            $sites[] = ['user' => $user, 'domains' => array_values(array_unique($domains)), 'status' => 'failed', 'reclaimed' => '0B', 'message' => $detail !== '' ? substr($detail, 0, 240) : 'Docker did not complete the cleanup.'];
            continue;
        }
        $reclaimed = '0B';
        if (preg_match('/^Total:\s*(.+)$/mi', $result['stdout'], $match)) $reclaimed = trim($match[1]);
        $unchanged = preg_match('/^0(?:\.0+)?\s*(?:B|kB|KB|MB|GB|TB)$/i', $reclaimed) === 1;
        $sites[] = [
            'user' => $user,
            'domains' => array_values(array_unique($domains)),
            'status' => $unchanged ? 'unchanged' : 'cleaned',
            'reclaimed' => $reclaimed,
            'message' => $unchanged ? 'No disposable build cache exceeded the retained allowance.' : 'Unused build layers were removed; containers, images, volumes, and application files were preserved.',
        ];
    }
    $after = resourceFilesystemUsage();
    @unlink($directory . '/resource-storage.json');
    flock($lock, LOCK_UN);
    fclose($lock);
    return [
        'generatedAt' => gmdate(DATE_ATOM),
        'reclaimedBytes' => max(0, (int) $before['usedBytes'] - (int) $after['usedBytes']),
        'retainedBuildCacheBytes' => $retainedBytes,
        'sites' => $sites,
        'note' => 'Only unused BuildKit cache was considered. Running containers, images, volumes, databases, backups, and application files were not pruned.',
    ];
}

function storageHygieneFile(): string
{
    return '/var/lib/panelavo/storage-hygiene.json';
}

function storagePressureState(?array $stored = null): array
{
    $filesystem = resourceFilesystemUsage();
    $total = max(1, (int) $filesystem['totalBytes']);
    $used = max(0, (int) $filesystem['usedBytes']);
    $available = max(0, (int) $filesystem['availableBytes']);
    $percent = round($used / $total * 100, 1);
    $reserve = max(2000000000, min(10000000000, (int) floor($total * 0.10)));
    $blocked = $percent >= 92 || $available < $reserve;
    return array_merge(is_array($stored) ? $stored : [], [
        'checkedAt' => gmdate(DATE_ATOM),
        'beforePercent' => $stored['beforePercent'] ?? $percent,
        'afterPercent' => $percent,
        'blocked' => $blocked,
        'reason' => $blocked
            ? 'Disk growth is paused until at least ' . number_format($reserve / 1000000000, 1) . ' GB is available and usage is below 92%.'
            : null,
        'availableBytes' => $available,
        'requiredAvailableBytes' => $reserve,
    ]);
}

function saveStorageHygieneState(array $state): void
{
    $file = storageHygieneFile();
    $temporary = $file . '.' . bin2hex(random_bytes(6)) . '.tmp';
    if (@file_put_contents($temporary, json_encode($state, JSON_PRETTY_PRINT), LOCK_EX) === false) return;
    @chmod($temporary, 0600);
    @rename($temporary, $file);
}

function loadStorageHygieneState(): array
{
    $stored = @json_decode((string) @file_get_contents(storageHygieneFile()), true);
    return storagePressureState(is_array($stored) ? $stored : null);
}

function runStorageHygiene($manager): array
{
    $directory = '/var/lib/panelavo';
    if (!is_dir($directory)) @mkdir($directory, 0711, true);
    $before = resourceFilesystemUsage();
    $beforePercent = round((int) $before['usedBytes'] / max(1, (int) $before['totalBytes']) * 100, 1);
    $existing = @json_decode((string) @file_get_contents(storageHygieneFile()), true);
    $existing = is_array($existing) ? $existing : [];
    if ($beforePercent < 75) {
        $state = storagePressureState($existing);
        $state['beforePercent'] = $beforePercent;
        saveStorageHygieneState($state);
        return $state;
    }

    $mode = $beforePercent >= 90 ? 'emergency' : 'normal';
    $cooldown = $mode === 'emergency' ? 3600 : 21600;
    $lastCleanup = isset($existing['lastCleanupAt']) ? strtotime((string) $existing['lastCleanupAt']) : false;
    if (is_int($lastCleanup) && time() - $lastCleanup < $cooldown) {
        $state = storagePressureState(array_merge($existing, ['mode' => $mode, 'beforePercent' => $beforePercent]));
        saveStorageHygieneState($state);
        return $state;
    }

    $lock = @fopen($directory . '/storage-hygiene.lock', 'c');
    if (!is_resource($lock) || !flock($lock, LOCK_EX | LOCK_NB)) {
        if (is_resource($lock)) fclose($lock);
        return storagePressureState(array_merge($existing, [
            'mode' => $mode,
            'beforePercent' => $beforePercent,
            'reason' => 'Storage cleanup is already running.',
        ]));
    }
    @chmod($directory . '/storage-hygiene.lock', 0600);

    $retainedBytes = $mode === 'emergency' ? 1000000000 : 5000000000;
    $users = [];
    foreach (resourceSites($manager) as $site) {
        $user = (string) $site['user'];
        if (preg_match('/^[A-Za-z0-9._-]{1,64}$/', $user)) $users[$user] = true;
    }
    foreach (array_keys($users) as $user) {
        $help = resourceRootlessDockerCommand($user, ['builder', 'prune', '--help'], 8);
        if ($help !== null && $help['code'] === 0 && str_contains($help['stdout'], '--max-used-space')) {
            resourceRootlessDockerCommand($user, [
                'builder', 'prune', '--all', '--force', '--max-used-space', (string) $retainedBytes,
            ], 600);
        }
        if ($mode === 'emergency') {
            // Docker preserves images referenced by running or stopped
            // containers. The age filter avoids deleting fresh rollback images.
            resourceRootlessDockerCommand($user, [
                'image', 'prune', '--all', '--force', '--filter', 'until=720h',
            ], 600);
        }
    }
    $after = resourceFilesystemUsage();
    $state = storagePressureState([
        'lastCleanupAt' => gmdate(DATE_ATOM),
        'mode' => $mode,
        'beforePercent' => $beforePercent,
        'reclaimedBytes' => max(0, (int) $before['usedBytes'] - (int) $after['usedBytes']),
    ]);
    saveStorageHygieneState($state);
    @unlink($directory . '/resource-storage.json');
    flock($lock, LOCK_UN);
    fclose($lock);
    return $state;
}

function serverStorage($manager, bool $refresh = false): array
{
    $directory = '/var/lib/panelavo';
    if (!is_dir($directory)) @mkdir($directory, 0700, true);
    $file = $directory . '/resource-storage.json';
    $requestedAt = time();
    $cache = is_file($file) ? json_decode((string) @file_get_contents($file), true) : null;
    $ttl = !empty($cache['complete']) ? 1800 : 60;
    if (!$refresh && is_array($cache) && isset($cache['generatedUnix'], $cache['data']) && time() - (int) $cache['generatedUnix'] < $ttl && is_array($cache['data'])) {
        return $cache['data'];
    }
    $lock = @fopen($directory . '/resource-storage.lock', 'c');
    if (is_resource($lock)) {
        @chmod($directory . '/resource-storage.lock', 0600);
        flock($lock, LOCK_EX);
        $cache = is_file($file) ? json_decode((string) @file_get_contents($file), true) : null;
        $ttl = !empty($cache['complete']) ? 1800 : 60;
        $fresh = is_array($cache) && isset($cache['generatedUnix'], $cache['data']) && is_array($cache['data']);
        if ($fresh && ((!$refresh && time() - (int) $cache['generatedUnix'] < $ttl) || (int) $cache['generatedUnix'] >= $requestedAt)) {
            flock($lock, LOCK_UN); fclose($lock);
            return $cache['data'];
        }
    }

    $filesystem = resourceFilesystemUsage();
    $sites = resourceSites($manager);
    $siteUsers = [];
    foreach ($sites as $site) {
        $user = (string) $site['user'];
        if (!preg_match('/^[A-Za-z0-9._-]{1,64}$/', $user)) continue;
        $siteUsers[$user]['domains'][] = (string) $site['domain'];
    }
    ksort($siteUsers);

    $paths = [];
    foreach (array_keys($siteUsers) as $user) {
        $path = resourceRootPath('/home/' . $user);
        if ($path) { $siteUsers[$user]['path'] = $path; $paths[] = $path; }
    }
    $otherHome = [];
    $homeEntries = array_merge(glob('/home/*') ?: [], glob('/home/.[!.]*') ?: []);
    foreach (array_values(array_unique($homeEntries)) as $path) {
        if (is_link($path) || dirname($path) !== '/home' || in_array($path, array_column($siteUsers, 'path'), true)) continue;
        $path = resourceRootPath($path);
        if ($path) { $otherHome[] = $path; $paths[] = $path; }
    }
    $osPaths = array_values(array_filter(array_map('resourceRootPath', ['/usr', '/etc', '/opt'])));
    $servicePaths = array_values(array_filter(array_map('resourceRootPath', ['/var'])));
    $adminPaths = array_values(array_filter(array_map('resourceRootPath', ['/root'])));
    $temporaryPaths = array_values(array_filter(array_map('resourceRootPath', ['/tmp'])));
    $miscPaths = array_values(array_filter(array_map('resourceRootPath', ['/srv', '/mnt', '/media'])));
    $paths = array_values(array_unique(array_merge($paths, $osPaths, $servicePaths, $adminPaths, $temporaryPaths, $miscPaths)));
    $usage = resourceDirectoryUsage($paths);

    $detailsForPaths = static function (array $groupPaths) use ($usage): array {
        $details = [];
        foreach ($groupPaths as $path) if (isset($usage[$path])) $details[] = ['label' => $path, 'bytes' => $usage[$path]];
        usort($details, static fn($a, $b) => $b['bytes'] <=> $a['bytes']);
        return $details;
    };
    $siteDetails = [];
    foreach ($siteUsers as $user => $metadata) {
        $path = $metadata['path'] ?? null;
        if (!$path || !isset($usage[$path])) continue;
        $domains = array_values(array_unique($metadata['domains'] ?? []));
        $siteDetails[] = [
            'label' => $user,
            'bytes' => $usage[$path],
            'note' => ($domains ? implode(', ', $domains) . '. ' : '') . 'Includes application roots, rootless Docker data, backups, caches, and other files in this site user home.',
            'metrics' => resourceRootlessDockerMetrics($user),
        ];
    }
    usort($siteDetails, static fn($a, $b) => $b['bytes'] <=> $a['bytes']);

    $makeGroup = static function (string $id, string $label, string $description, array $details): array {
        return [
            'id' => $id,
            'label' => $label,
            'bytes' => array_sum(array_column($details, 'bytes')),
            'description' => $description,
            'details' => $details,
        ];
    };
    $groups = [
        $makeGroup('site-users', 'Site users', 'Complete site-user home directories, including application roots, Docker data, backups, and caches.', $siteDetails),
        $makeGroup('system-users', 'Other users and home data', 'Panel services, database helpers, swap files, and other data stored directly under /home.', $detailsForPaths($otherHome)),
        $makeGroup('operating-system', 'Operating system', 'Installed system software and configuration on this filesystem.', $detailsForPaths($osPaths)),
        $makeGroup('system-services', 'System and service data', 'Databases, logs, package state, and other service data under /var.', $detailsForPaths($servicePaths)),
        $makeGroup('administrator', 'Administrator data', 'Files, caches, and tools under the root administrator home.', $detailsForPaths($adminPaths)),
        $makeGroup('temporary', 'Temporary files', 'Temporary data on the root filesystem.', $detailsForPaths($temporaryPaths)),
    ];
    $knownBytes = array_sum(array_column($groups, 'bytes')) + array_sum(array_map(static fn($path) => $usage[$path] ?? 0, $miscPaths));
    $otherBytes = max(0, (int) $filesystem['usedBytes'] - $knownBytes);
    $otherDetails = $detailsForPaths($miscPaths);
    if ($otherBytes > 0) $otherDetails[] = [
        'label' => 'Filesystem overhead and unclassified data',
        'bytes' => $otherBytes,
        'note' => 'Includes filesystem metadata and files outside the measured top-level groups.',
    ];
    $groups[] = $makeGroup('other', 'Other and filesystem overhead', 'Allocated space not assigned to the explicit groups above.', $otherDetails);
    $missing = count(array_diff($paths, array_keys($usage)));
    $data = [
        'generatedAt' => gmdate(DATE_ATOM),
        'totalBytes' => (int) $filesystem['totalBytes'],
        'usedBytes' => (int) $filesystem['usedBytes'],
        'availableBytes' => (int) $filesystem['availableBytes'],
        'reservedBytes' => (int) $filesystem['reservedBytes'],
        'accountedBytes' => $knownBytes,
        'groups' => $groups,
        'hygiene' => loadStorageHygieneState(),
        'note' => 'Directory totals use allocated blocks on the root filesystem. Docker image, volume, and build-cache figures are Docker-reported drill-down values and may overlap because layers are shared.' . ($missing ? ' ' . $missing . ' path(s) did not finish within the bounded scan and remain in Other.' : ''),
    ];
    $temporary = $file . '.' . bin2hex(random_bytes(6)) . '.tmp';
    $stored = ['generatedUnix' => time(), 'complete' => $missing === 0, 'data' => $data];
    if (@file_put_contents($temporary, json_encode($stored), LOCK_EX) !== false) { @chmod($temporary, 0600); @rename($temporary, $file); }
    if (is_resource($lock)) { flock($lock, LOCK_UN); fclose($lock); }
    return $data;
}

function resourceSiteRoot(Site $site, array $overrides): ?string
{
    $user = (string) $site->getUser();
    if (!preg_match('/^[A-Za-z0-9._-]{1,64}$/', $user)) return null;
    $base = realpath('/home/' . $user . '/htdocs');
    if (!$base || !is_dir($base)) return null;
    $domain = strtolower((string) $site->getDomainName());
    $relative = trim(str_replace('\\', '/', (string) ($overrides[$domain] ?? $site->getRootDirectory())), '/');
    if (strlen($relative) > 200 || str_contains($relative, "\0")) return null;
    foreach ($relative === '' ? [] : explode('/', $relative) as $part) {
        if ($part === '' || $part === '.' || $part === '..' || !preg_match('/^[A-Za-z0-9._-]+$/', $part)) return null;
    }
    $candidate = $base . ($relative === '' ? '' : '/' . $relative);
    if (!pathIsContained($candidate, $base)) return null;
    return realpath($candidate) ?: (is_dir($candidate) ? $candidate : null);
}

function resourceSites($manager): array
{
    global $input;
    $roots = is_array($input['siteRoots'] ?? null) ? $input['siteRoots'] : [];
    $types = is_array($input['siteTypes'] ?? null) ? $input['siteTypes'] : [];
    $sites = [];
    foreach ($manager->getRepository(Site::class)->findAll() as $site) {
        $domain = strtolower((string) $site->getDomainName());
        $type = (string) ($types[$domain] ?? $site->getType());
        if (!in_array($type, ['php', 'nodejs', 'static', 'python', 'reverse-proxy', 'docker'], true)) $type = 'reverse-proxy';
        $sites[] = [
            'domain' => $domain,
            'user' => (string) $site->getUser(),
            'type' => $type,
            'root' => resourceSiteRoot($site, $roots),
            'port' => expectedSitePort($site),
        ];
    }
    return $sites;
}

function resourceProcesses(array $cpuByPid): array
{
    $items = [];
    foreach (glob('/proc/[0-9]*') ?: [] as $directory) {
        $pid = (int) basename($directory);
        $uid = @fileowner($directory);
        if ($pid < 1 || $uid === false) continue;
        $status = (string) @file_get_contents($directory . '/status');
        preg_match('/^VmRSS:\s+(\d+)\s+kB$/mi', $status, $rssMatch);
        $rss = (int) ($rssMatch[1] ?? 0) * 1024;
        $pss = null;
        $rollup = @file_get_contents($directory . '/smaps_rollup');
        if (is_string($rollup) && preg_match('/^Pss:\s+(\d+)\s+kB$/mi', $rollup, $pssMatch)) {
            $pss = (int) $pssMatch[1] * 1024;
        }
        $cwd = @readlink($directory . '/cwd');
        $cmdline = @file_get_contents($directory . '/cmdline');
        $cgroup = (string) @file_get_contents($directory . '/cgroup');
        $items[] = [
            'pid' => $pid,
            'uid' => (int) $uid,
            'cpuPercent' => (float) ($cpuByPid[$pid] ?? 0),
            'memoryBytes' => $pss ?? $rss,
            'pss' => $pss !== null,
            'cwd' => is_string($cwd) ? preg_replace('/ \(deleted\)$/', '', $cwd) : '',
            'cmdline' => is_string($cmdline) ? str_replace("\0", ' ', substr($cmdline, 0, 4096)) : '',
            'cgroup' => $cgroup,
        ];
    }
    return $items;
}

function resourceRootContainers(array $processes): array
{
    $docker = is_executable('/usr/bin/docker') ? '/usr/bin/docker' : (is_executable('/usr/local/bin/docker') ? '/usr/local/bin/docker' : null);
    if (!$docker) return [];
    $ids = [];
    foreach ($processes as $process) {
        if (preg_match('/user-\d+\.slice/', $process['cgroup'])) continue;
        if (preg_match('/(?:docker[-\/]|cri-containerd[-\/])([a-f0-9]{12,64})(?:\.scope)?/i', $process['cgroup'], $match)) $ids[] = strtolower($match[1]);
    }
    $ids = array_values(array_unique($ids));
    if (!$ids) return [];
    $inspected = resourceCommand(array_merge([$docker, 'inspect'], array_slice($ids, 0, 200)), 3);
    $decoded = json_decode($inspected['stdout'], true);
    return is_array($decoded) ? $decoded : [];
}

function resourceContainerSites(array $sites, array $processes): array
{
    $result = [];
    foreach (resourceRootContainers($processes) as $container) {
        $id = strtolower((string) ($container['Id'] ?? ''));
        if (!preg_match('/^[a-f0-9]{12,64}$/', $id)) continue;
        $labels = is_array($container['Config']['Labels'] ?? null) ? $container['Config']['Labels'] : [];
        $paths = [];
        foreach (['com.docker.compose.project.working_dir', 'com.docker.compose.project.config_files'] as $key) {
            if (is_string($labels[$key] ?? null)) $paths[] = $labels[$key];
        }
        foreach (($container['Mounts'] ?? []) as $mount) if (is_string($mount['Source'] ?? null)) $paths[] = $mount['Source'];
        $ports = [];
        foreach (($container['NetworkSettings']['Ports'] ?? []) as $bindings) {
            foreach (is_array($bindings) ? $bindings : [] as $binding) {
                $port = (int) ($binding['HostPort'] ?? 0);
                if ($port > 0) $ports[] = $port;
            }
        }
        $project = strtolower((string) ($labels['com.docker.compose.project'] ?? ''));
        $scores = [];
        $sources = [];
        foreach ($sites as $index => $site) {
            $score = 0;
            if ($project !== '' && $project === composeProjectNameForDomain($site['domain'])) { $score += 8; $sources[$index][] = 'container'; }
            foreach ($paths as $path) {
                if ($site['root'] && pathIsContained((string) $path, $site['root'])) { $score += 6; $sources[$index][] = 'path'; break; }
            }
            if ($site['port'] && in_array((int) $site['port'], $ports, true)) { $score += 5; $sources[$index][] = 'port'; }
            if ($score > 0) $scores[$index] = $score;
        }
        if (!$scores) continue;
        arsort($scores);
        $indexes = array_keys($scores);
        if (count($indexes) > 1 && $scores[$indexes[0]] === $scores[$indexes[1]]) continue;
        $result[$id] = ['site' => $indexes[0], 'sources' => array_values(array_unique($sources[$indexes[0]] ?? ['container']))];
    }
    return $result;
}

function composeProjectNameForDomain(string $domain): string
{
    $name = trim(strtolower((string) preg_replace('/[^a-z0-9]+/i', '-', $domain)), '-');
    return 'panelavo-' . ($name !== '' ? $name : 'site');
}

function resourceDiskUsage(array $sites): array
{
    $directory = '/var/lib/panelavo';
    if (!is_dir($directory)) @mkdir($directory, 0700, true);
    $file = $directory . '/resource-disk.json';
    $cache = is_file($file) ? json_decode((string) @file_get_contents($file), true) : null;
    if (!is_array($cache)) $cache = ['updatedAt' => 0, 'bytes' => [], 'cursor' => 0, 'complete' => false];
    if (!is_array($cache['bytes'] ?? null)) $cache['bytes'] = [];
    $roots = array_values(array_unique(array_filter(array_column($sites, 'root'), 'is_string')));
    $ttl = !empty($cache['complete']) ? 600 : 15;
    if (time() - (int) ($cache['updatedAt'] ?? 0) >= $ttl && $roots) {
        $missing = array_values(array_diff($roots, array_keys(is_array($cache['bytes'] ?? null) ? $cache['bytes'] : [])));
        $priority = $missing ?: $roots;
        $cursor = (int) ($cache['cursor'] ?? 0) % count($priority);
        $priority = array_merge(array_slice($priority, $cursor), array_slice($priority, 0, $cursor));
        $scanRoots = array_values(array_unique(array_merge($priority, $roots)));
        $du = is_executable('/usr/bin/du') ? '/usr/bin/du' : '/bin/du';
        $scan = resourceCommand(array_merge([$du, '-sb', '--one-file-system', '--'], $scanRoots), 3);
        $completed = 0;
        foreach (preg_split('/\R/', trim($scan['stdout'])) ?: [] as $line) {
            if (preg_match('/^(\d+)\s+(.+)$/', $line, $match)) { $cache['bytes'][$match[2]] = (int) $match[1]; $completed++; }
        }
        $cache['updatedAt'] = time();
        $cache['cursor'] = ($cursor + max(1, $completed)) % count($priority);
        $cache['complete'] = count(array_diff($roots, array_keys($cache['bytes']))) === 0;
        $temporary = $file . '.' . bin2hex(random_bytes(6)) . '.tmp';
        if (@file_put_contents($temporary, json_encode($cache), LOCK_EX) !== false) { @chmod($temporary, 0600); @rename($temporary, $file); }
    }
    return is_array($cache['bytes'] ?? null) ? $cache['bytes'] : [];
}

function resourceBucket(): array
{
    return ['cpuPercent' => 0.0, 'memoryBytes' => 0, 'processes' => 0];
}

function addResourceProcess(array &$bucket, array $process): void
{
    $bucket['cpuPercent'] += (float) $process['cpuPercent'];
    $bucket['memoryBytes'] += (int) $process['memoryBytes'];
    $bucket['processes']++;
}

function resourceCommandReferencesRoot(string $command, string $root): bool
{
    return preg_match('/(?:^|[\s=:\"\'])' . preg_quote($root, '/') . '(?:\/|$|[\s:\"\'])/', $command) === 1;
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

    $sites = resourceSites($manager);
    $processes = resourceProcesses($cpuSample['byPid']);
    $containerSites = resourceContainerSites($sites, $processes);
    $diskByRoot = resourceDiskUsage($sites);

    $siteIndexesByUser = [];
    $uidToUser = [];
    foreach ($sites as $index => $site) {
        $siteIndexesByUser[$site['user']][] = $index;
        $account = function_exists('posix_getpwnam') ? posix_getpwnam($site['user']) : false;
        if (is_array($account)) $uidToUser[(int) $account['uid']] = $site['user'];
    }
    $websiteBuckets = array_fill(0, count($sites), null);
    foreach ($websiteBuckets as $index => $_) $websiteBuckets[$index] = resourceBucket();
    $websiteSources = array_fill(0, count($sites), []);
    $shared = resourceBucket();
    $system = resourceBucket();

    foreach ($processes as $process) {
        $siteIndex = null;
        $sources = [];
        $containerized = preg_match('/(?:docker[-\/]|cri-containerd[-\/])([a-f0-9]{12,64})(?:\.scope)?/i', $process['cgroup'], $match) === 1;
        if ($containerized) {
            $containerId = strtolower($match[1]);
            foreach ($containerSites as $knownId => $matchData) {
                if (str_starts_with($knownId, $containerId) || str_starts_with($containerId, $knownId)) {
                    $siteIndex = $matchData['site']; $sources = $matchData['sources']; break;
                }
            }
        }
        if ($siteIndex === null) {
            $pathMatches = [];
            foreach ($sites as $index => $site) {
                if (!$site['root']) continue;
                if (($process['cwd'] !== '' && pathIsContained($process['cwd'], $site['root'])) || resourceCommandReferencesRoot($process['cmdline'], $site['root'])) {
                    $pathMatches[$index] = strlen($site['root']);
                }
            }
            if ($pathMatches) { arsort($pathMatches); $siteIndex = array_key_first($pathMatches); $sources[] = 'path'; }
        }
        $siteUser = $uidToUser[$process['uid']] ?? null;
        if ($siteIndex === null && preg_match('/user-(\d+)\.slice/', $process['cgroup'], $uidMatch)) {
            $siteUser = $uidToUser[(int) $uidMatch[1]] ?? $siteUser;
            if ($siteUser) $sources[] = 'container';
        }
        // A rootful container's internal UID can numerically equal an
        // unrelated host site UID. If Docker/path/port evidence did not match
        // it, keep it in System instead of falling back to that coincidence.
        if ($siteIndex === null && $containerized && !preg_match('/user-\d+\.slice/', $process['cgroup'])) {
            addResourceProcess($system, $process);
            continue;
        }
        if ($siteIndex === null && $siteUser) {
            $candidates = $siteIndexesByUser[$siteUser] ?? [];
            if (count($candidates) === 1) { $siteIndex = $candidates[0]; $sources[] = 'owner'; }
            else { addResourceProcess($shared, $process); continue; }
        }
        if ($siteIndex === null) addResourceProcess($system, $process);
        else {
            addResourceProcess($websiteBuckets[$siteIndex], $process);
            $websiteSources[$siteIndex] = array_values(array_unique(array_merge($websiteSources[$siteIndex], $sources)));
        }
    }

    $websites = [];
    foreach ($sites as $index => $site) {
        $bucket = $websiteBuckets[$index];
        $diskShared = false;
        if ($site['root']) foreach ($sites as $otherIndex => $other) {
            if ($index === $otherIndex || !$other['root']) continue;
            if (pathIsContained($site['root'], $other['root']) || pathIsContained($other['root'], $site['root'])) { $diskShared = true; break; }
        }
        $websites[] = [
            'domain' => $site['domain'],
            'siteUser' => $site['user'],
            'type' => $site['type'],
            'cpuPercent' => round($bucket['cpuPercent'], 1),
            'memoryBytes' => $bucket['memoryBytes'],
            'processes' => $bucket['processes'],
            'diskBytes' => $site['root'] !== null && isset($diskByRoot[$site['root']]) ? $diskByRoot[$site['root']] : null,
            'diskShared' => $diskShared,
            'sources' => $websiteSources[$index],
        ];
    }
    usort($websites, fn($a, $b) => ($b['memoryBytes'] <=> $a['memoryBytes']) ?: strcmp($a['domain'], $b['domain']));

    // Backward-compatible per-user totals for MCP clients released before the
    // website attribution model. Memory is PSS when the kernel exposes it.
    $byUser = [];
    foreach ($processes as $process) {
        $account = function_exists('posix_getpwuid') ? posix_getpwuid($process['uid']) : false;
        $name = is_array($account) ? (string) ($account['name'] ?? $process['uid']) : (string) $process['uid'];
        $byUser[$name] ??= ['user' => $name, 'cpuPercent' => 0.0, 'memoryPercent' => 0.0, 'memoryBytes' => 0, 'processes' => 0];
        $byUser[$name]['cpuPercent'] += $process['cpuPercent'];
        $byUser[$name]['memoryBytes'] += $process['memoryBytes'];
        $byUser[$name]['processes']++;
    }
    $domainsByUser = [];
    foreach ($sites as $site) $domainsByUser[$site['user']][] = $site['domain'];
    foreach ($domainsByUser as $siteUser => $domains) {
        $byUser[$siteUser] ??= ['user' => $siteUser, 'cpuPercent' => 0.0, 'memoryPercent' => 0.0, 'memoryBytes' => 0, 'processes' => 0];
        $byUser[$siteUser]['domains'] = $domains;
        $uniqueRoots = array_values(array_unique(array_filter(array_map(static fn($site) => $site['user'] === $siteUser ? $site['root'] : null, $sites), 'is_string')));
        $known = array_filter(array_map(static fn($root) => $diskByRoot[$root] ?? null, $uniqueRoots), 'is_int');
        if ($known) $byUser[$siteUser]['diskBytes'] = array_sum($known);
    }
    $users = array_values($byUser);
    usort($users, fn($a, $b) => ($b['memoryBytes'] <=> $a['memoryBytes']));
    foreach ($users as &$entry) {
        $entry['cpuPercent'] = round($entry['cpuPercent'], 1);
        $entry['memoryPercent'] = $memTotal ? round($entry['memoryBytes'] / $memTotal * 100, 1) : 0;
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
        'websites' => $websites,
        'shared' => [
            'cpuPercent' => round($shared['cpuPercent'], 1),
            'memoryBytes' => $shared['memoryBytes'],
            'processes' => $shared['processes'],
        ],
        'system' => [
            'cpuPercent' => round($system['cpuPercent'], 1),
            'memoryBytes' => $system['memoryBytes'],
            'processes' => $system['processes'],
        ],
        'attribution' => [
            'memoryMethod' => count(array_filter($processes, static fn($process) => !$process['pss'] && $process['memoryBytes'] > 0)) === 0 ? 'pss' : 'rss',
            'note' => 'Processes are assigned only by Unix ownership, application-root evidence, rootless cgroup ownership, or uniquely matched root-Docker metadata. Unresolved and shared processes are kept separate instead of guessed.',
        ],
    ];
}

function softwareVersion(string $command, string $pattern = '/(\d+\.\d+(?:\.\d+)*)/'): string
{
    $output = (string) shell_exec('timeout 5 ' . $command . ' 2>&1');
    return preg_match($pattern, $output, $m) ? $m[1] : '';
}

function hostMaintenanceStatus(bool $refresh = false): array
{
    $cacheFile = '/var/lib/panelavo/host-maintenance.json';
    $cached = @json_decode((string) @file_get_contents($cacheFile), true);
    if (!$refresh && is_array($cached) && isset($cached['checkedAt'])
        && time() - strtotime((string) $cached['checkedAt']) < 3600) return $cached;
    $simulation = resourceCommand([
        '/usr/bin/apt-get', '-s', '-o', 'Debug::NoLocking=true', 'upgrade',
    ], 45);
    $updates = 0;
    $security = 0;
    foreach (preg_split('/\R/', $simulation['stdout']) ?: [] as $line) {
        if (!str_starts_with($line, 'Inst ')) continue;
        $updates++;
        if (preg_match('/(?:-security|UbuntuESMApps|UbuntuESMInfra)/i', $line)) $security++;
    }
    $unattended = resourceCommand([
        '/usr/bin/systemctl', 'is-enabled', 'unattended-upgrades.service',
    ], 5);
    $timer = resourceCommand([
        '/usr/bin/systemctl', 'is-enabled', 'apt-daily-upgrade.timer',
    ], 5);
    $stamp = '/var/lib/apt/periodic/update-success-stamp';
    if (!is_file($stamp)) {
        $lists = glob('/var/lib/apt/lists/*InRelease') ?: [];
        usort($lists, static fn($a, $b) => (int) @filemtime($b) <=> (int) @filemtime($a));
        $stamp = $lists[0] ?? '';
    }
    $rebootRequired = is_file('/var/run/reboot-required');
    $automation = $unattended['code'] === 0 && $timer['code'] === 0;
    $status = [
        'checkedAt' => gmdate(DATE_ATOM),
        'availableUpdates' => $updates,
        'securityUpdates' => $security,
        'rebootRequired' => $rebootRequired,
        'unattendedUpgrades' => $automation,
        'lastPackageIndexAt' => $stamp !== '' && is_file($stamp) ? gmdate(DATE_ATOM, (int) filemtime($stamp)) : null,
        'status' => $rebootRequired ? 'reboot-required' : ($security > 0 || !$automation ? 'attention' : 'current'),
    ];
    $temporary = $cacheFile . '.tmp-' . bin2hex(random_bytes(4));
    if (@file_put_contents($temporary, json_encode($status, JSON_PRETTY_PRINT), LOCK_EX) !== false) {
        @chmod($temporary, 0600);
        @rename($temporary, $cacheFile);
    }
    return $status;
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
        'maintenance' => hostMaintenanceStatus(),
    ];
}

function runGit(Site $site, array $args, bool $allowFailure = false): array
{
    $cwd = realpath(siteRootPath($site));
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

function freshSiteScaffoldInventory(string $root, array $ignored = []): ?array
{
    $entries = array_values(array_diff(scandir($root) ?: [], ['.', '..', '.well-known'], $ignored));
    sort($entries, SORT_STRING);
    if (!$entries || count($entries) > 10) return null;
    $files = [];
    $total = 0;
    foreach ($entries as $name) {
        $path = $root . '/' . $name;
        if (is_link($path) || !is_file($path)) return null;
        $size = filesize($path);
        if (!is_int($size) || $size < 0 || $size > 1048576) return null;
        $total += $size;
        if ($total > 2097152) return null;
        $sha256 = hash_file('sha256', $path);
        if (!is_string($sha256)) return null;
        $files[] = ['name' => $name, 'size' => $size, 'sha256' => $sha256];
    }
    return $files;
}

function freshSiteScaffoldPath(Site $site, bool $create): ?string
{
    $parent = dirname(PANELAVO_FRESH_SITE_SCAFFOLD_ROOT);
    foreach ([$parent, PANELAVO_FRESH_SITE_SCAFFOLD_ROOT] as $index => $directory) {
        if (is_link($directory)) return null;
        if (!is_dir($directory)) {
            if (!$create || !@mkdir($directory, $index === 0 ? 0755 : 0700, true)) return null;
        }
        $real = realpath($directory);
        $stat = @lstat($directory);
        if ($real !== $directory || !is_array($stat) || (int) ($stat['uid'] ?? -1) !== 0) return null;
    }
    @chmod(PANELAVO_FRESH_SITE_SCAFFOLD_ROOT, 0700);
    $identity = strtolower((string) $site->getId() . "\n" . (string) $site->getDomainName());
    return PANELAVO_FRESH_SITE_SCAFFOLD_ROOT . '/' . hash('sha256', $identity) . '.json';
}

function captureFreshSiteScaffold(Site $site): void
{
    $root = realpath(siteRootPath($site));
    if (!$root || !is_dir($root)) return;
    $files = freshSiteScaffoldInventory($root);
    $path = $files ? freshSiteScaffoldPath($site, true) : null;
    if (!$path) return;
    $encoded = json_encode([
        'version' => 1,
        'siteId' => (string) $site->getId(),
        'domain' => strtolower((string) $site->getDomainName()),
        'root' => $root,
        'files' => $files,
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if (!is_string($encoded)) return;
    $temporary = $path . '.tmp-' . bin2hex(random_bytes(6));
    if (@file_put_contents($temporary, $encoded, LOCK_EX) === false) return;
    @chmod($temporary, 0600);
    if (!@rename($temporary, $path)) @unlink($temporary);
}

function loadFreshSiteScaffold(Site $site, string $root, array $ignored = []): ?array
{
    $path = freshSiteScaffoldPath($site, false);
    if (!$path || is_link($path) || !is_file($path)) return null;
    $manifest = json_decode((string) @file_get_contents($path), true);
    if (!is_array($manifest)
        || (int) ($manifest['version'] ?? 0) !== 1
        || (string) ($manifest['siteId'] ?? '') !== (string) $site->getId()
        || strtolower((string) ($manifest['domain'] ?? '')) !== strtolower((string) $site->getDomainName())
        || (string) ($manifest['root'] ?? '') !== $root
        || !is_array($manifest['files'] ?? null)) {
        return null;
    }
    $current = freshSiteScaffoldInventory($root, $ignored);
    return is_array($current) && hash_equals(
        hash('sha256', json_encode($manifest['files'], JSON_UNESCAPED_SLASHES) ?: ''),
        hash('sha256', json_encode($current, JSON_UNESCAPED_SLASHES) ?: ''),
    ) ? ['path' => $path, 'files' => $current] : null;
}

function gitChanges(Site $site): array
{
    $raw = runGit($site, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], true)['stdout'];
    if ($raw === '') return [];
    $records = explode("\0", $raw);
    $changes = [];
    for ($index = 0; $index < count($records); $index++) {
        $record = $records[$index];
        if ($record === '') continue;
        $status = substr($record, 0, 2);
        $path = substr($record, 3);
        $change = ['status' => $status, 'path' => $path];
        if (str_contains($status, 'R') || str_contains($status, 'C')) {
            $change['originalPath'] = $records[++$index] ?? '';
        }
        $changes[] = $change;
    }
    return $changes;
}

// A CloudPanel site user must be able to manage every path in its application
// root even when a rootful container or another runtime owns the inode. Keep
// ownership intact and grant only that site user read/write/traverse access.
// Default ACLs on every existing directory make the same access inherit onto
// future files and directories, including bind-mount writes from containers.
function ensureSiteProjectAccess(Site $site): void
{
    $root = realpath(siteRootPath($site));
    if (!$root || !is_dir($root)) return;
    $user = (string) $site->getUser();
    $homeRoot = realpath('/home/' . $user . '/htdocs');
    if (!$homeRoot || ($root !== $homeRoot && !str_starts_with($root, $homeRoot . '/'))) {
        respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    }
    $setfacl = findSiteTool('/root', 'setfacl', true);
    $getfacl = findSiteTool('/root', 'getfacl', true);
    if (!$setfacl || !$getfacl) {
        respond([
            'ok' => false,
            'code' => 'TOOL_UNAVAILABLE',
            'message' => 'Project access enforcement requires the acl package. Run the trusted Panelavo setup.sh as root.',
        ]);
    }

    // The root default entry is the initialization marker. Once present, all
    // descendants created under the managed tree inherit the invariant, so
    // ordinary workspace reads do not repeatedly traverse large repositories.
    $current = runSiteCommand($site, [$getfacl, '--absolute-names', '--omit-header', $root], 30, true);
    $quotedUser = preg_quote($user, '/');
    if ($current['code'] === 0
        && preg_match('/^user:' . $quotedUser . ':rwx$/m', $current['stdout'])
        && preg_match('/^default:user:' . $quotedUser . ':rwx$/m', $current['stdout'])) {
        return;
    }

    $access = runSiteCommand(
        $site,
        [$setfacl, '--physical', '--recursive', '--modify', 'u:' . $user . ':rwX,m::rwX', $root],
        900,
        true,
    );
    if ($access['code'] !== 0) {
        respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'Could not grant the site user project access: ' . trim($access['stderr'] ?: $access['stdout'])]);
    }
    $inheritance = runSiteCommand(
        $site,
        ['/usr/bin/find', '-P', $root, '-type', 'd', '-exec', $setfacl, '--modify', 'd:u:' . $user . ':rwx,d:m::rwx', '{}', '+'],
        900,
        true,
    );
    if ($inheritance['code'] !== 0) {
        respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'Could not enable inherited site-user project access: ' . trim($inheritance['stderr'] ?: $inheritance['stdout'])]);
    }
}

function invalidBrokerRequest(): never
{
    respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
}

function brokerString(
    array $input,
    string $key,
    int $minimum,
    int $maximum,
    ?string $pattern = null,
): string {
    $value = $input[$key] ?? null;
    if (!is_string($value) || strlen($value) < $minimum || strlen($value) > $maximum) {
        invalidBrokerRequest();
    }
    if ($pattern !== null && preg_match($pattern, $value) !== 1) invalidBrokerRequest();
    return $value;
}

function brokerDomainValue(mixed $value): string
{
    if (!is_string($value)) invalidBrokerRequest();
    $domain = strtolower(trim($value));
    if (strlen($domain) > 253 || preg_match('/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/', $domain) !== 1) {
        invalidBrokerRequest();
    }
    return $domain;
}

function brokerPassword(mixed $value): string
{
    if (!is_string($value) || strlen($value) < 12 || strlen($value) > 128 || preg_match('/[\x00-\x1f\x7f]/', $value)) {
        invalidBrokerRequest();
    }
    return $value;
}

function brokerRuntimeValue(mixed $value): string
{
    if (!is_string($value) || preg_match('/^[A-Za-z0-9._-]{1,32}$/', $value) !== 1) invalidBrokerRequest();
    return $value;
}

function brokerPortValue(mixed $value): int
{
    if (!is_int($value) && !(is_string($value) && ctype_digit($value))) invalidBrokerRequest();
    $port = (int) $value;
    if ($port < 1024 || $port > 65535) invalidBrokerRequest();
    return $port;
}

function panelavoRuntimeDir(): string
{
    $path = '/run/panelavo';
    if (is_link($path)) respond(['ok' => false, 'code' => 'BROKER_INTEGRITY_FAILED'], 1);
    if (!is_dir($path) && !mkdir($path, 0700, true)) {
        respond(['ok' => false, 'code' => 'BROKER_INTEGRITY_FAILED'], 1);
    }
    $real = realpath($path);
    $mode = @fileperms($path);
    if ($real !== $path || @fileowner($path) !== 0 || $mode === false || (($mode & 0077) !== 0)) {
        respond(['ok' => false, 'code' => 'BROKER_INTEGRITY_FAILED'], 1);
    }
    return $path;
}

function runClpctl(array $args, int $timeout = 90): array
{
    foreach ($args as $arg) {
        if (!is_string($arg) || str_contains($arg, "\0") || strlen($arg) > 4096) invalidBrokerRequest();
    }
    $timeout = max(1, min($timeout, 900));
    $command = array_merge([
        '/usr/bin/timeout', '--signal=KILL', $timeout . 's',
        '/usr/bin/env', '-i',
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'HOME=/root',
        'LANG=C.UTF-8',
        '/usr/bin/clpctl',
    ], $args);
    $process = proc_open(
        $command,
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes,
        '/',
    );
    if (!is_resource($process)) respond(['ok' => false, 'code' => 'CLPCTL_FAILED']);
    fclose($pipes[0]);
    $stdout = substr((string) stream_get_contents($pipes[1]), 0, 500000);
    fclose($pipes[1]);
    $stderr = substr((string) stream_get_contents($pipes[2]), 0, 100000);
    fclose($pipes[2]);
    $code = proc_close($process);
    return [
        'code' => $code,
        'timedOut' => in_array($code, [124, 137], true),
        'stdout' => $stdout,
        'stderr' => $stderr,
    ];
}

function finishClpctl(array $result, ?array $data = null): never
{
    if (($result['code'] ?? 1) !== 0) {
        $detail = trim((string) (($result['stderr'] ?? '') ?: ($result['stdout'] ?? '')));
        respond([
            'ok' => false,
            'code' => !empty($result['timedOut']) ? 'REQUEST_TIMEOUT' : 'CLPCTL_FAILED',
            // The Node boundary maps this to a fixed public message. Keeping a
            // bounded detail here preserves duplicate/validation classification.
            'message' => substr($detail, 0, 2000),
        ]);
    }
    respond(['ok' => true] + ($data === null ? [] : ['data' => $data]));
}

function requireSiteWriter($manager, User $user, string $domain, bool $panelAdmin): Site
{
    $site = authorizedSite($manager, $user, $domain);
    if (!in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true) && !$panelAdmin) {
        respond(['ok' => false, 'code' => 'FORBIDDEN']);
    }
    return $site;
}

function gitChangedPath(Site $site, string $requested): array
{
    if ($requested === '' || str_contains($requested, "\0")) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    foreach (gitChanges($site) as $change) {
        if (hash_equals((string) $change['path'], $requested)) return $change;
    }
    respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
}

function gitFileDiff(Site $site, array $change): string
{
    $path = (string) $change['path'];
    if ($change['status'] === '??') {
        return runGit($site, ['diff', '--no-index', '--no-color', '--', '/dev/null', $path], true)['stdout'];
    }
    $result = runGit($site, ['diff', '--no-color', 'HEAD', '--', $path], true);
    if ($result['code'] === 0) return $result['stdout'];
    $cached = runGit($site, ['diff', '--cached', '--no-color', '--', $path], true)['stdout'];
    $working = runGit($site, ['diff', '--no-color', '--', $path], true)['stdout'];
    return $cached . $working;
}

function gitSection(Site $site, ?array $selectedChange = null, ?string $notice = null): array
{
    $root = siteRootPath($site);
    $repo = is_dir($root . '/.git');
    if (!$repo) return ['isRepository' => false, 'path' => $root];
    $branch = trim(runGit($site, ['branch', '--show-current'], true)['stdout']);
    $head = trim(runGit($site, ['rev-parse', '--short', 'HEAD'], true)['stdout']);
    $remotesRaw = trim(runGit($site, ['remote', '-v'], true)['stdout']);
    $branchesRaw = trim(runGit($site, ['branch', '--format=%(refname:short)'], true)['stdout']);
    $logRaw = trim(runGit($site, ['log', '-20', '--pretty=format:%h%x09%an%x09%ar%x09%s'], true)['stdout']);
    $data = ['isRepository' => true, 'path' => $root, 'branch' => $branch, 'head' => $head,
        'remotes' => array_values(array_filter(array_map(fn($line) => preg_split('/\s+/', $line), explode("\n", $remotesRaw)))),
        'branches' => $branchesRaw === '' ? [] : explode("\n", $branchesRaw),
        'changes' => gitChanges($site),
        'commits' => $logRaw === '' ? [] : array_map(function ($line) { $p = explode("\t", $line, 4); return ['hash' => $p[0] ?? '', 'author' => $p[1] ?? '', 'date' => $p[2] ?? '', 'subject' => $p[3] ?? '']; }, explode("\n", $logRaw))];
    if ($selectedChange !== null) $data['selectedDiff'] = ['path' => $selectedChange['path'], 'diff' => substr(gitFileDiff($site, $selectedChange), 0, 300000)];
    if ($notice !== null) $data['notice'] = $notice;
    return $data;
}

// Managed artifact releases keep immutable trees outside the configured
// application root and make that root one atomic symlink pointer. The first
// activation adopts the existing directory as the initial rollback release.
// Docker Compose is deliberately excluded here: bind mounts require the
// separate data-aware deployment contract rather than a code-only swap.
function managedReleasePaths(Site $site): array
{
    $user = (string) $site->getUser();
    $base = realpath('/home/' . $user . '/htdocs');
    $relative = configuredSiteRootDirectory($site);
    if (!$base || $relative === '' || str_starts_with($relative, '.panelavo-releases')) {
        respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'Managed releases require an application root below the site htdocs directory.']);
    }
    $root = $base . '/' . $relative;
    if (!pathIsContained($root, $base)) invalidBrokerRequest();
    $key = substr(hash('sha256', $relative), 0, 24);
    $managed = $base . '/.panelavo-releases/' . $key;
    return [
        'base' => $base,
        'relative' => $relative,
        'root' => $root,
        'managed' => $managed,
        'releases' => $managed . '/releases',
    ];
}

function safeReleaseRelativePath(mixed $value): string
{
    if (!is_string($value) || strlen($value) < 1 || strlen($value) > 240 || str_contains($value, "\0")) invalidBrokerRequest();
    $path = trim(str_replace('\\', '/', $value), '/');
    if ($path === '') invalidBrokerRequest();
    foreach (explode('/', $path) as $part) {
        if ($part === '' || $part === '.' || $part === '..' || preg_match('/^[A-Za-z0-9._-]+$/', $part) !== 1) invalidBrokerRequest();
    }
    return $path;
}

function validatePanelavoArtifact(array $operation): string
{
    $path = brokerString($operation, 'artifactPath', 1, 1024);
    $name = brokerString($operation, 'artifactName', 1, 255, '/^[^\/\\\\\x00]+\.(tar\.gz|tgz)$/i');
    if (basename($name) !== $name) invalidBrokerRequest();
    $expected = strtolower(brokerString($operation, 'expectedSha256', 64, 64, '/^[a-fA-F0-9]{64}$/'));
    $real = realpath($path);
    $callerUid = (int) (getenv('PANELAVO_CALLER_UID') ?: -1);
    $account = function_exists('posix_getpwuid') ? posix_getpwuid($callerUid) : false;
    $callerHome = is_array($account) ? realpath('/home/' . (string) ($account['name'] ?? '') . '/htdocs') : false;
    if (!$real || !$callerHome || !is_file($real) || is_link($path)
        || @fileowner($real) !== $callerUid
        || !str_starts_with($real, $callerHome . '/')
        || preg_match('#/\.data/mcp-artifacts/[0-9a-f-]{36}\.part$#i', $real) !== 1) {
        respond(['ok' => false, 'code' => 'FORBIDDEN']);
    }
    $actual = hash_file('sha256', $real);
    if (!is_string($actual) || !hash_equals($expected, $actual)) {
        respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The completed artifact no longer matches its declared SHA-256 checksum.']);
    }
    return $real;
}

function assertReleaseRootHasNoMounts(string $root): void
{
    $normalized = normalizeAbsolutePath($root);
    $mountInfo = @file('/proc/self/mountinfo', FILE_IGNORE_NEW_LINES) ?: [];
    foreach ($mountInfo as $line) {
        $parts = explode(' ', $line);
        if (count($parts) < 5) continue;
        $mount = str_replace(['\\040', '\\011', '\\012', '\\134'], [' ', "\t", "\n", '\\'], $parts[4]);
        $mount = normalizeAbsolutePath($mount);
        if ($normalized && $mount && ($mount === $normalized || str_starts_with($mount, $normalized . '/'))) {
            respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'Managed code releases cannot adopt an application root containing a mounted filesystem.']);
        }
    }
}

function inspectReleaseArchive(Site $site, string $artifact, int $stripComponents, string $cwd, int $maximumBytes): void
{
    $names = runSiteCommand($site, ['/usr/bin/tar', 'tzf', $artifact], 300, true, [], $cwd);
    $listing = runSiteCommand($site, ['/usr/bin/tar', 'tvzf', $artifact], 300, true, [], $cwd);
    if ($names['code'] !== 0 || $listing['code'] !== 0
        || str_contains($names['stdout'], '[stdout truncated by Panelavo]')
        || str_contains($listing['stdout'], '[stdout truncated by Panelavo]')) {
        respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The tar archive is invalid or too large to validate safely.']);
    }
    $top = null;
    $count = 0;
    foreach (preg_split('/\R/', trim($names['stdout'])) ?: [] as $entry) {
        if ($entry === '') continue;
        $count++;
        if ($count > 10000) respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'Managed release archives are limited to 10,000 entries.']);
        $normalized = str_replace('\\', '/', $entry);
        if (str_starts_with($normalized, '/') || str_contains($normalized, "\0") || preg_match('/[\x00-\x1f\x7f]/', $normalized)) invalidBrokerRequest();
        $parts = array_values(array_filter(explode('/', trim($normalized, '/')), static fn(string $part): bool => $part !== '' && $part !== '.'));
        if (!$parts) continue;
        foreach ($parts as $part) if ($part === '..') invalidBrokerRequest();
        if ($stripComponents === 1) {
            if ($top === null) $top = $parts[0];
            if ($parts[0] !== $top) respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'stripComponents=1 requires one common top-level archive folder.']);
        }
    }
    if ($count === 0) invalidBrokerRequest();
    $unpackedBytes = 0;
    foreach (preg_split('/\R/', trim($listing['stdout'])) ?: [] as $entry) {
        if ($entry !== '' && !in_array($entry[0], ['-', 'd'], true)) {
            respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'Managed releases reject archive links and special filesystem entries.']);
        }
        if ($entry === '') continue;
        if (preg_match('/^\S+\s+\S+\s+(\d+)\s+/', trim($entry), $match) !== 1) invalidBrokerRequest();
        $unpackedBytes += (int) $match[1];
        if ($unpackedBytes > $maximumBytes) {
            respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The unpacked release would exceed the safe storage allowance.']);
        }
    }
}

function preserveReleaseEnvironment(string $current, string $staged): void
{
    foreach (PANELAVO_ENV_FILES as $name) {
        $source = $current . '/' . $name;
        $target = $staged . '/' . $name;
        if (!is_file($source) || is_link($source) || (int) @filesize($source) > 262144) continue;
        if (is_link($target) || (file_exists($target) && !is_file($target))) invalidBrokerRequest();
        if (!@copy($source, $target)) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'Could not preserve the existing environment file for the staged release.']);
        @chmod($target, @fileperms($source) & 0777);
    }
}

function resolveManagedReleasePlan(Site $site, User $user, string $relative, string $plan): array
{
    global $input;
    $previous = $input['applicationRootDirectory'] ?? null;
    $hadPrevious = array_key_exists('applicationRootDirectory', $input);
    $input['applicationRootDirectory'] = $relative;
    try {
        ensureSiteProjectAccess($site);
        $state = operationsState($site, $user);
        return resolveDeploymentPlan($site, $state, $plan);
    } finally {
        if ($hadPrevious) $input['applicationRootDirectory'] = $previous;
        else unset($input['applicationRootDirectory']);
    }
}

function switchManagedRelease(string $root, string $target): bool
{
    $temporary = dirname($root) . '/.panelavo-release-pointer-' . bin2hex(random_bytes(8));
    if (!@symlink($target, $temporary) || !@rename($temporary, $root)) {
        @unlink($temporary);
        return false;
    }
    return true;
}

function currentManagedRelease(array $paths): ?string
{
    if (!is_link($paths['root'])) return null;
    $target = realpath($paths['root']);
    if (!$target || !str_starts_with($target, $paths['releases'] . '/') || dirname($target) !== $paths['releases']) {
        respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'The application root is a symlink not managed by Panelavo.']);
    }
    return $target;
}

function runManagedReleasePlan(Site $site, array $steps, string $healthPath): array
{
    $results = executeOperationSteps($site, $steps);
    $last = end($results) ?: ['exitCode' => 1, 'timedOut' => false, 'output' => 'No deployment step ran.'];
    $health = ['code' => 1, 'stdout' => '', 'stderr' => 'Deployment steps failed before the health check.'];
    if ((int) $last['exitCode'] === 0) {
        $domain = (string) $site->getDomainName();
        $health = runSiteCommand($site, [
            'curl', '--fail', '--silent', '--show-error', '--output', '/dev/null',
            '--retry', '12', '--retry-delay', '5', '--retry-all-errors',
            '--connect-timeout', '3', '--max-time', '90',
            '--resolve', $domain . ':443:127.0.0.1',
            'https://' . $domain . $healthPath,
        ], 120);
    }
    return ['steps' => $results, 'health' => $health, 'ok' => (int) $last['exitCode'] === 0 && $health['code'] === 0];
}

function listManagedReleases(Site $site): array
{
    $paths = managedReleasePaths($site);
    $current = is_link($paths['root']) ? currentManagedRelease($paths) : null;
    $items = [];
    foreach (glob($paths['releases'] . '/*', GLOB_ONLYDIR) ?: [] as $directory) {
        $id = basename($directory);
        if (preg_match('/^[A-Za-z0-9._-]{1,100}$/', $id) !== 1) continue;
        $items[] = [
            'id' => $id,
            'current' => $current !== null && hash_equals($current, (string) realpath($directory)),
            'createdAt' => gmdate(DATE_ATOM, (int) (@filemtime($directory) ?: time())),
        ];
    }
    usort($items, static fn(array $a, array $b): int => strcmp($b['createdAt'], $a['createdAt']));
    return ['managed' => is_link($paths['root']), 'items' => $items];
}

function retainManagedReleases(array $paths, string $current, int $retain = 10): void
{
    $directories = glob($paths['releases'] . '/*', GLOB_ONLYDIR) ?: [];
    usort($directories, static fn(string $a, string $b): int => ((int) @filemtime($b)) <=> ((int) @filemtime($a)));
    $kept = 0;
    foreach ($directories as $directory) {
        $real = realpath($directory);
        if (!$real || dirname($real) !== $paths['releases']) continue;
        if (hash_equals($real, $current)) continue;
        if ($kept < max(0, $retain - 1)) {
            $kept++;
            continue;
        }
        deleteTree($real);
    }
}

function manageArtifactRelease(Site $site, User $user, array $operation): array
{
    $action = (string) ($operation['action'] ?? '');
    if ($action === 'list') return listManagedReleases($site);
    $paths = managedReleasePaths($site);
    $releaseId = brokerString($operation, 'releaseId', 1, 100, '/^[A-Za-z0-9._-]+$/');
    $plan = brokerString($operation, 'plan', 1, 32, '/^(node|static-build|php|python)$/');
    $healthPath = brokerString($operation, 'healthPath', 1, 500, '#^/[A-Za-z0-9._~!$&\'()*+,;=:@%/-]*(\?[A-Za-z0-9._~!$&\'()*+,;=:@%/?-]*)?$#');
    if (!is_dir($paths['releases']) && !@mkdir($paths['releases'], 0750, true)) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED']);
    foreach ([$paths['base'] . '/.panelavo-releases', $paths['managed'], $paths['releases']] as $directory) {
        @chown($directory, $site->getUser());
        @chgrp($directory, $site->getUser());
        @chmod($directory, 0750);
    }
    $lock = @fopen('/var/lock/panelavo-operations-' . $site->getUser() . '.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) respond(['ok' => false, 'code' => 'OPERATION_BUSY']);
    try {
        if ($action === 'deploy') {
            if (!preg_match('/^[0-9a-f-]{36}$/i', $releaseId)) invalidBrokerRequest();
            $artifact = validatePanelavoArtifact($operation);
            $strip = $operation['stripComponents'] ?? null;
            if (!in_array($strip, [0, 1], true)) invalidBrokerRequest();
            $destination = $paths['releases'] . '/' . $releaseId;
            if (file_exists($destination) || is_link($destination)) invalidBrokerRequest();
            $currentReal = realpath($paths['root']);
            if (!$currentReal || !is_dir($currentReal)) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'The current application root must exist before its first managed release.']);
            if (!is_link($paths['root'])) assertReleaseRootHasNoMounts($paths['root']);
            $freeBytes = (int) (@disk_free_space($paths['releases']) ?: 0);
            $maximumBytes = min(10 * 1024 * 1024 * 1024, (int) floor($freeBytes * 0.7));
            if ($maximumBytes < 1024 * 1024) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'There is not enough free storage to stage this release safely.']);
            inspectReleaseArchive($site, $artifact, $strip, $currentReal, $maximumBytes);
            $staging = $paths['releases'] . '/.staging-' . $releaseId;
            if (!@mkdir($staging, 0700)) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED']);
            $extract = runSiteCommand($site, array_merge(
                ['/usr/bin/tar', 'xzf', $artifact, '--no-same-owner', '--no-same-permissions'],
                $strip === 1 ? ['--strip-components=1'] : [],
                ['-C', $staging],
            ), 900, true, [], $staging);
            if ($extract['code'] !== 0) { deleteTree($staging); respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The validated release archive could not be extracted.']); }
            $entries = array_values(array_diff(@scandir($staging) ?: [], ['.', '..']));
            if (!$entries) { deleteTree($staging); invalidBrokerRequest(); }
            foreach ((array) ($operation['requiredPaths'] ?? []) as $required) {
                $relative = safeReleaseRelativePath($required);
                if (!file_exists($staging . '/' . $relative) && !is_link($staging . '/' . $relative)) {
                    deleteTree($staging);
                    respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'A required release path is missing: ' . $relative]);
                }
            }
            preserveReleaseEnvironment($currentReal, $staging);
            @mkdir($staging . '/.well-known/acme-challenge', 0755, true);
            $ownership = runSiteCommand($site, ['/usr/bin/chown', '-R', '--', $site->getUser() . ':' . $site->getUser(), $staging], 900, true, [], $staging);
            if ($ownership['code'] !== 0 || !@rename($staging, $destination)) { deleteTree($staging); respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED']); }
        } elseif ($action === 'rollback') {
            $destination = realpath($paths['releases'] . '/' . $releaseId);
            if (!$destination || dirname($destination) !== $paths['releases'] || !is_dir($destination)) invalidBrokerRequest();
            if (!is_link($paths['root'])) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'This website has not adopted managed releases yet.']);
        } else invalidBrokerRequest();

        $destination = (string) realpath($destination);
        $destinationRelative = substr($destination, strlen($paths['base']) + 1);
        $steps = resolveManagedReleasePlan($site, $user, $destinationRelative, $plan);
        $previous = currentManagedRelease($paths);
        if ($previous === null) {
            $legacyId = 'legacy-' . gmdate('YmdHis') . '-' . bin2hex(random_bytes(4));
            $previous = $paths['releases'] . '/' . $legacyId;
            if (!@rename($paths['root'], $previous)) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'Could not adopt the existing application as the rollback release.']);
            if (!switchManagedRelease($paths['root'], $destination)) {
                @rename($previous, $paths['root']);
                respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'Could not atomically activate the release pointer.']);
            }
        } else {
            if (hash_equals($previous, $destination)) invalidBrokerRequest();
            if (!switchManagedRelease($paths['root'], $destination)) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'Could not atomically activate the release pointer.']);
        }
        $run = runManagedReleasePlan($site, $steps, $healthPath);
        if (!$run['ok']) {
            if (!switchManagedRelease($paths['root'], $previous)) {
                respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The release failed and the previous release pointer could not be restored. Inspect the website immediately.']);
            }
            $previousRelative = substr($previous, strlen($paths['base']) + 1);
            $rollbackSteps = resolveManagedReleasePlan($site, $user, $previousRelative, $plan);
            $rollback = runManagedReleasePlan($site, $rollbackSteps, $healthPath);
            respond([
                'ok' => false,
                'code' => 'SITE_UPDATE_FAILED',
                'message' => $rollback['ok']
                    ? 'The release failed its deployment or health gate and Panelavo restored the previous release.'
                    : 'The release failed and automatic rollback also failed. Inspect the website immediately.',
            ]);
        }
        ensureSiteProjectAccess($site);
        retainManagedReleases($paths, $destination);
        $listing = listManagedReleases($site);
        return ['releaseId' => $releaseId, 'activated' => true, 'run' => $run, 'releases' => $listing['items']];
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

function recoveryRun(string $command, array $steps, string $startedAt): array
{
    $last = end($steps) ?: ['exitCode' => 1, 'timedOut' => false, 'output' => 'No recovery step ran.'];
    return [
        'command' => $command,
        'display' => count($steps) . ' controlled recovery step(s) executed',
        'exitCode' => (int) ($last['exitCode'] ?? 1),
        'timedOut' => !empty($last['timedOut']),
        'output' => implode("\n\n", array_map(
            static fn(array $item): string => '── ' . ($item['label'] ?? $command) . ' (' . ($item['display'] ?? 'controlled recovery') . ")\n" . (($item['output'] ?? '') !== '' ? $item['output'] : '(no output)'),
            $steps,
        )),
        'startedAt' => $startedAt,
        'finishedAt' => gmdate(DATE_ATOM),
        'steps' => $steps,
    ];
}

function manageSiteRecovery(Site $site, User $user, array $operation): array
{
    $action = (string) ($operation['action'] ?? '');
    if ($action === 'diagnose-proxy') {
        $startedAt = gmdate(DATE_ATOM);
        $state = operationsState($site, $user);
        $steps = executeOperationSteps($site, [resolveOperationStep($state, 'upstream-check', [])]);
        return ['run' => recoveryRun($action, $steps, $startedAt)];
    }
    if (!in_array($action, ['repair-site-acl', 'restart-rootless-runtime', 'recover-rootless-migration'], true)) invalidBrokerRequest();
    if ($action === 'recover-rootless-migration' && $user->getRole() !== User::ROLE_ADMIN) {
        respond(['ok' => false, 'code' => 'FORBIDDEN']);
    }
    $lock = @fopen('/var/lock/panelavo-operations-' . $site->getUser() . '.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) respond(['ok' => false, 'code' => 'OPERATION_BUSY']);
    $startedAt = gmdate(DATE_ATOM);
    try {
        if ($action === 'repair-site-acl') {
            $root = realpath(siteRootPath($site));
            if (!$root || !is_dir($root)) respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'The application root does not exist.']);
            ensureSiteProjectAccess($site);
            $steps = [[
                'command' => $action,
                'label' => 'Repair site-user project access',
                'display' => 'reapply contained access and inherited directory ACLs',
                'exitCode' => 0,
                'timedOut' => false,
                'output' => 'The site-user ACL invariant is present on the configured application root.',
            ]];
        } elseif ($action === 'restart-rootless-runtime') {
            $steps = [];
            executeFix($site, 'initialize-rootless-runtime', $steps);
        } else {
            $outcome = recoverRootlessMigration($site);
            $steps = (array) ($outcome['steps'] ?? []);
        }
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
    return ['run' => recoveryRun($action, $steps, $startedAt)];
}

// Selective LanceDB snapshots deliberately operate at whole-table directory
// boundaries. Lance tables are versioned physical trees; copying individual
// files can create a manifest/data mismatch. Compose is stopped for creation
// and restore so no writer or cached table handle survives a table swap.
function lanceDatastoreDirectory(Site $site, string $relative): array
{
    $relative = safeReleaseRelativePath($relative);
    $root = realpath(siteRootPath($site));
    $directory = $root ? realpath($root . '/' . $relative) : false;
    if (!$root || !$directory || !is_dir($directory) || is_link($root . '/' . $relative)
        || ($directory !== $root && !pathIsContained($directory, $root))) {
        respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The LanceDB path must be a physical directory inside the configured application root.']);
    }
    $cursor = $root;
    foreach (explode('/', $relative) as $part) {
        $cursor .= '/' . $part;
        if (is_link($cursor)) respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The LanceDB path cannot contain symbolic links.']);
    }
    return ['root' => $root, 'relative' => $relative, 'directory' => $directory];
}

function lanceTableSummary(string $directory, string $name): array
{
    $path = $directory . '/' . $name . '.lance';
    $validName = preg_match('/^[A-Za-z0-9_.-]{1,100}$/', $name) === 1;
    $valid = $validName && is_dir($path) && !is_link($path);
    foreach (['_transactions', '_versions', 'data'] as $required) {
        if (!$valid || !is_dir($path . '/' . $required) || is_link($path . '/' . $required)) $valid = false;
    }
    $bytes = 0; $entries = 0;
    if ($valid) {
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::SELF_FIRST,
        );
        foreach ($iterator as $entry) {
            if (++$entries > 200000 || $entry->isLink()) { $valid = false; break; }
            if ($entry->isFile()) $bytes += max(0, (int) $entry->getSize());
        }
    }
    return ['name' => $name, 'valid' => $valid, 'bytes' => $bytes, 'entries' => $entries];
}

function lanceTableInventory(string $directory): array
{
    $tables = [];
    foreach (glob($directory . '/*.lance', GLOB_ONLYDIR) ?: [] as $path) {
        $base = basename($path);
        $name = substr($base, 0, -6);
        $tables[] = lanceTableSummary($directory, $name);
    }
    usort($tables, static fn(array $a, array $b): int => strcmp($a['name'], $b['name']));
    return $tables;
}

function lancePatterns(array $operation, string $key, array $default): array
{
    if (!array_key_exists($key, $operation)) return $default;
    $value = $operation[$key];
    if (!is_array($value) || count($value) > 100) invalidBrokerRequest();
    $patterns = [];
    foreach ($value as $pattern) {
        if (!is_string($pattern) || preg_match('/^[A-Za-z0-9_.*?-]{1,100}$/', $pattern) !== 1) invalidBrokerRequest();
        $patterns[] = $pattern;
    }
    return array_values(array_unique($patterns));
}

function selectLanceTables(array $tables, array $include, array $exclude): array
{
    $selected = [];
    foreach ($tables as $table) {
        $name = is_array($table) ? (string) ($table['name'] ?? '') : (string) $table;
        $included = false;
        foreach ($include as $pattern) if (fnmatch($pattern, $name, FNM_NOESCAPE)) { $included = true; break; }
        if (!$included) continue;
        foreach ($exclude as $pattern) if (fnmatch($pattern, $name, FNM_NOESCAPE)) { $included = false; break; }
        if ($included) $selected[] = $name;
    }
    sort($selected, SORT_STRING);
    if (!$selected || count($selected) > 1000) {
        respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => !$selected
            ? 'The include/exclude rules did not select any LanceDB tables.'
            : 'A selective snapshot can contain at most 1,000 LanceDB tables.']);
    }
    return $selected;
}

function lanceSnapshotRoot(Site $site): string
{
    return '/home/' . $site->getUser() . '/backups/datastores';
}

function writeLanceManifest(Site $site, string $path, array $manifest): bool
{
    $temporary = $path . '.tmp-' . bin2hex(random_bytes(4));
    $encoded = json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    $ok = is_string($encoded) && @file_put_contents($temporary, $encoded . "\n", LOCK_EX) !== false
        && @chown($temporary, $site->getUser()) && @chgrp($temporary, $site->getUser())
        && @chmod($temporary, 0600) && @rename($temporary, $path);
    if (!$ok) @unlink($temporary);
    return $ok;
}

function lanceSnapshotManifest(Site $site, string $snapshotId, ?string $relative = null): array
{
    if (preg_match('/^[A-Za-z0-9-]{1,64}$/', $snapshotId) !== 1) invalidBrokerRequest();
    $root = lanceSnapshotRoot($site);
    $directory = realpath($root . '/' . $snapshotId);
    if (!$directory || dirname($directory) !== realpath($root) || is_link($directory)) {
        respond(['ok' => false, 'code' => 'SITE_NOT_FOUND', 'message' => 'The selective datastore snapshot was not found.']);
    }
    $manifestPath = $directory . '/manifest.json';
    $archive = $directory . '/tables.tar.gz';
    $manifest = json_decode((string) @file_get_contents($manifestPath), true);
    if (!is_array($manifest) || ($manifest['driver'] ?? null) !== 'lancedb'
        || ($manifest['snapshotId'] ?? null) !== $snapshotId || !is_file($archive) || is_link($archive)
        || ($relative !== null && ($manifest['path'] ?? null) !== $relative)) {
        respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The datastore snapshot manifest is invalid or belongs to another path.']);
    }
    $actual = @hash_file('sha256', $archive);
    if (!is_string($actual) || !hash_equals((string) ($manifest['sha256'] ?? ''), $actual)) {
        respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The datastore snapshot checksum does not match its manifest.']);
    }
    return ['directory' => $directory, 'archive' => $archive, 'manifest' => $manifest];
}

function listLanceSnapshots(Site $site, string $relative): array
{
    $root = lanceSnapshotRoot($site);
    $items = [];
    foreach (glob($root . '/*', GLOB_ONLYDIR) ?: [] as $directory) {
        $id = basename($directory);
        if (preg_match('/^[A-Za-z0-9-]{1,64}$/', $id) !== 1 || is_link($directory)) continue;
        $manifest = json_decode((string) @file_get_contents($directory . '/manifest.json'), true);
        if (!is_array($manifest) || ($manifest['driver'] ?? null) !== 'lancedb' || ($manifest['path'] ?? null) !== $relative) continue;
        $items[] = [
            'snapshotId' => $id,
            'createdAt' => (string) ($manifest['createdAt'] ?? ''),
            'tables' => array_values((array) ($manifest['tables'] ?? [])),
            'bytes' => (int) ($manifest['bytes'] ?? 0),
            'sha256' => (string) ($manifest['sha256'] ?? ''),
        ];
    }
    usort($items, static fn(array $a, array $b): int => strcmp($b['createdAt'], $a['createdAt']));
    return array_slice($items, 0, 100);
}

function lanceComposeSteps(Site $site, User $user): array
{
    $state = operationsState($site, $user);
    if (empty($state['hasCompose']) || empty($state['compose']['safe']) || empty($state['compose']['daemonAvailable'])) {
        respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'Selective LanceDB operations require a safe, ready rootless Compose project.']);
    }
    $start = [resolveOperationStep($state, 'compose-up', [])];
    if (!empty($state['expectedPort'])) $start[] = resolveOperationStep($state, 'compose-port-verify', []);
    return ['stop' => [resolveOperationStep($state, 'compose-down', [])], 'start' => $start];
}

function stepsSucceeded(array $steps): bool
{
    if (!$steps) return false;
    foreach ($steps as $step) if ((int) ($step['exitCode'] ?? 1) !== 0) return false;
    return true;
}

function lanceReadyCheck(Site $site, string $path): array
{
    if (preg_match('#^/[A-Za-z0-9._~!$&\'()*+,;=:@%/-]*(\?[A-Za-z0-9._~!$&\'()*+,;=:@%/?-]*)?$#', $path) !== 1) invalidBrokerRequest();
    $domain = (string) $site->getDomainName();
    return runSiteCommand($site, [
        'curl', '--fail', '--silent', '--show-error', '--output', '/dev/null',
        '--retry', '12', '--retry-delay', '5', '--retry-all-errors',
        '--connect-timeout', '3', '--max-time', '90',
        '--resolve', $domain . ':443:127.0.0.1',
        'https://' . $domain . $path,
    ], 120);
}

function lanceDataChecks(Site $site, array $checks): array
{
    if (count($checks) > 10) invalidBrokerRequest();
    $domain = (string) $site->getDomainName();
    $results = [];
    foreach ($checks as $check) {
        if (!is_array($check)) invalidBrokerRequest();
        $path = brokerString($check, 'path', 1, 500, '#^/[A-Za-z0-9._~!$&\'()*+,;=:@%/-]*(\?[A-Za-z0-9._~!$&\'()*+,;=:@%/?-]*)?$#');
        $field = brokerString($check, 'field', 1, 160, '/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/');
        $comparison = brokerString($check, 'comparison', 1, 16, '/^(equal|minimum)$/');
        $expected = $check['expected'] ?? null;
        if (!is_int($expected) && !is_float($expected)) invalidBrokerRequest();
        $probe = runSiteCommand($site, [
            'curl', '--fail', '--silent', '--show-error', '--connect-timeout', '3', '--max-time', '30',
            '--resolve', $domain . ':443:127.0.0.1', 'https://' . $domain . $path,
        ], 45);
        $json = $probe['code'] === 0 ? json_decode(trim($probe['stdout']), true) : null;
        $value = $json;
        foreach (explode('.', $field) as $part) $value = is_array($value) && array_key_exists($part, $value) ? $value[$part] : null;
        $passed = is_int($value) || is_float($value);
        if ($passed) $passed = $comparison === 'equal' ? (float) $value === (float) $expected : (float) $value >= (float) $expected;
        $results[] = ['path' => $path, 'field' => $field, 'comparison' => $comparison, 'expected' => $expected, 'actual' => $value, 'passed' => $passed];
    }
    return $results;
}

function createLanceSnapshot(Site $site, User $user, array $paths, array $operation): array
{
    $inventory = lanceTableInventory($paths['directory']);
    $include = lancePatterns($operation, 'include', ['*']);
    $exclude = lancePatterns($operation, 'exclude', []);
    $selected = selectLanceTables($inventory, $include, $exclude);
    $byName = array_column($inventory, null, 'name');
    foreach ($selected as $name) if (empty($byName[$name]['valid'])) {
        respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'A selected LanceDB table is not a valid physical table tree: ' . $name]);
    }
    $readyPath = brokerString($operation, 'readyPath', 1, 500, '#^/[A-Za-z0-9._~!$&\'()*+,;=:@%/-]*(\?[A-Za-z0-9._~!$&\'()*+,;=:@%/?-]*)?$#');
    $compose = lanceComposeSteps($site, $user);
    $root = lanceSnapshotRoot($site);
    if (!is_dir($root) && !@mkdir($root, 0750, true)) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED']);
    @chown(dirname($root), $site->getUser()); @chgrp(dirname($root), $site->getUser()); @chmod(dirname($root), 0750);
    @chown($root, $site->getUser()); @chgrp($root, $site->getUser()); @chmod($root, 0750);
    $snapshotId = 'ds-' . gmdate('YmdHis') . '-' . bin2hex(random_bytes(4));
    $partial = $root . '/.partial-' . $snapshotId;
    $final = $root . '/' . $snapshotId;
    if (!@mkdir($partial, 0700)) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED']);
    @chown($partial, $site->getUser()); @chgrp($partial, $site->getUser());
    $lock = @fopen('/var/lock/panelavo-operations-' . $site->getUser() . '.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) { deleteTree($partial); respond(['ok' => false, 'code' => 'OPERATION_BUSY']); }
    try {
        $stopped = executeOperationSteps($site, $compose['stop']);
        if (!stepsSucceeded($stopped)) { deleteTree($partial); respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The rootless Compose project could not be quiesced safely.']); }
        $archive = $partial . '/tables.tar.gz';
        $entries = array_map(static fn(string $name): string => $name . '.lance', $selected);
        $tar = runSiteCommand($site, array_merge(['/usr/bin/tar', 'czf', $archive, '--'], $entries), 900, false, [], $paths['directory']);
        $started = executeOperationSteps($site, $compose['start']);
        $ready = stepsSucceeded($started) ? lanceReadyCheck($site, $readyPath) : ['code' => 1, 'stderr' => 'Compose restart failed.'];
        if ($tar['code'] !== 0 || !stepsSucceeded($started) || $ready['code'] !== 0) {
            deleteTree($partial);
            respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => $tar['code'] !== 0
                ? 'The selected LanceDB tables could not be archived; the website restart was still attempted.'
                : 'The snapshot completed but the website did not pass its restart/readiness gate.']);
        }
        $sha256 = @hash_file('sha256', $archive);
        $manifest = [
            'version' => 1,
            'snapshotId' => $snapshotId,
            'driver' => 'lancedb',
            'path' => $paths['relative'],
            'tables' => $selected,
            'createdAt' => gmdate(DATE_ATOM),
            'bytes' => (int) (@filesize($archive) ?: 0),
            'sha256' => is_string($sha256) ? $sha256 : '',
        ];
        if (!$manifest['sha256'] || !writeLanceManifest($site, $partial . '/manifest.json', $manifest) || !@rename($partial, $final)) {
            deleteTree($partial);
            respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED']);
        }
        return ['snapshot' => $manifest, 'stop' => $stopped, 'start' => $started, 'ready' => true];
    } finally {
        flock($lock, LOCK_UN); fclose($lock);
    }
}

function inspectLanceSnapshotArchive(Site $site, string $archive, array $tables): void
{
    $allowed = array_fill_keys(array_map(static fn(string $name): string => $name . '.lance', $tables), true);
    $names = runSiteCommand($site, ['/usr/bin/tar', 'tzf', $archive], 300, false, [], dirname($archive));
    $listing = runSiteCommand($site, ['/usr/bin/tar', 'tvzf', $archive], 300, false, [], dirname($archive));
    if ($names['code'] !== 0 || $listing['code'] !== 0
        || str_contains($names['stdout'], '[stdout truncated by Panelavo]')
        || str_contains($listing['stdout'], '[stdout truncated by Panelavo]')) {
        respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The datastore snapshot archive is invalid or too large to inspect safely.']);
    }
    $count = 0;
    foreach (preg_split('/\R/', trim($names['stdout'])) ?: [] as $entry) {
        if ($entry === '') continue;
        if (++$count > 200000) respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The datastore snapshot contains too many filesystem entries.']);
        $normalized = str_replace('\\', '/', $entry);
        if (str_starts_with($normalized, '/') || str_contains($normalized, "\0") || preg_match('/[\x00-\x1f\x7f]/', $normalized)) invalidBrokerRequest();
        $parts = array_values(array_filter(explode('/', trim($normalized, '/')), static fn(string $part): bool => $part !== '' && $part !== '.'));
        if (!$parts || !isset($allowed[$parts[0]])) invalidBrokerRequest();
        foreach ($parts as $part) if ($part === '..') invalidBrokerRequest();
    }
    if ($count === 0) invalidBrokerRequest();
    foreach (preg_split('/\R/', trim($listing['stdout'])) ?: [] as $entry) {
        if ($entry !== '' && !in_array($entry[0], ['-', 'd'], true)) {
            respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'Datastore snapshots reject links and special filesystem entries.']);
        }
    }
}

function prepareLanceRestoreOwnership(Site $site, string $datastore, string $staging, array $tables): void
{
    $identity = siteIdentity($site);
    $subuid = subordinateRange('/etc/subuid', $identity['user']);
    $subgid = subordinateRange('/etc/subgid', $identity['user']);
    $setfacl = findSiteTool('/root', 'setfacl', true);
    if (!$setfacl) respond(['ok' => false, 'code' => 'TOOL_UNAVAILABLE', 'message' => 'Selective datastore restore requires the acl package.']);
    foreach ($tables as $name) {
        $target = $datastore . '/' . $name . '.lance';
        $source = is_dir($target) && !is_link($target) ? $target : $datastore;
        $stat = @lstat($source);
        if (!is_array($stat)) invalidBrokerRequest();
        $uid = (int) $stat['uid']; $gid = (int) $stat['gid'];
        $uidAllowed = $uid === (int) $identity['uid'] || ($subuid && $uid >= $subuid['start'] && $uid < $subuid['start'] + $subuid['count']);
        $gidAllowed = $gid === (int) $identity['gid'] || ($subgid && $gid >= $subgid['start'] && $gid < $subgid['start'] + $subgid['count']);
        if (!$uidAllowed || !$gidAllowed) {
            respond(['ok' => false, 'code' => 'ACTION_UNAVAILABLE', 'message' => 'A selected table has ownership outside this rootless site user mapping. Repair or migrate ownership before restoring it.']);
        }
        $result = runSiteCommand($site, [
            '/usr/bin/chown', '-R', '--', $uid . ':' . $gid, $staging . '/' . $name . '.lance',
        ], 900, true, [], $staging);
        if ($result['code'] !== 0) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The staged table ownership could not be prepared safely.']);
        $table = $staging . '/' . $name . '.lance';
        $access = runSiteCommand($site, [
            $setfacl, '--physical', '--recursive', '--modify', 'u:' . $identity['user'] . ':rwX,m::rwX', $table,
        ], 900, true, [], $staging);
        $inheritance = runSiteCommand($site, [
            '/usr/bin/find', '-P', $table, '-type', 'd', '-exec', $setfacl,
            '--modify', 'd:u:' . $identity['user'] . ':rwx,d:m::rwx', '{}', '+',
        ], 900, true, [], $staging);
        if ($access['code'] !== 0 || $inheritance['code'] !== 0) {
            respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The staged table ACL invariant could not be prepared safely.']);
        }
    }
}

function restoreLanceSnapshot(Site $site, User $user, array $paths, array $operation): array
{
    $snapshotId = brokerString($operation, 'snapshotId', 1, 64, '/^[A-Za-z0-9-]+$/');
    $snapshot = lanceSnapshotManifest($site, $snapshotId, $paths['relative']);
    $include = lancePatterns($operation, 'include', ['*']);
    $exclude = lancePatterns($operation, 'exclude', []);
    $selected = selectLanceTables((array) ($snapshot['manifest']['tables'] ?? []), $include, $exclude);
    $readyPath = brokerString($operation, 'readyPath', 1, 500, '#^/[A-Za-z0-9._~!$&\'()*+,;=:@%/-]*(\?[A-Za-z0-9._~!$&\'()*+,;=:@%/?-]*)?$#');
    $checks = $operation['checks'] ?? [];
    if (!is_array($checks)) invalidBrokerRequest();
    $compose = lanceComposeSteps($site, $user);
    $manifestTables = (array) ($snapshot['manifest']['tables'] ?? []);
    foreach ($manifestTables as $name) if (!is_string($name) || preg_match('/^[A-Za-z0-9_.-]{1,100}$/', $name) !== 1) invalidBrokerRequest();
    inspectLanceSnapshotArchive($site, $snapshot['archive'], $manifestTables);
    $staging = dirname($paths['directory']) . '/.panelavo-lancedb-stage-' . bin2hex(random_bytes(6));
    if (!@mkdir($staging, 0700)) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED']);
    @chown($staging, $site->getUser()); @chgrp($staging, $site->getUser());
    $entries = array_map(static fn(string $name): string => $name . '.lance', $selected);
    $extract = runSiteCommand($site, array_merge([
        '/usr/bin/tar', 'xzf', $snapshot['archive'], '--no-same-owner', '--no-same-permissions', '-C', $staging, '--',
    ], $entries), 900, false, [], $staging);
    if ($extract['code'] !== 0) { deleteTree($staging); respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The validated snapshot could not be staged.']); }
    foreach ($selected as $name) if (empty(lanceTableSummary($staging, $name)['valid'])) {
        deleteTree($staging); respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'A staged LanceDB table failed structural validation: ' . $name]);
    }
    prepareLanceRestoreOwnership($site, $paths['directory'], $staging, $selected);
    $lock = @fopen('/var/lock/panelavo-operations-' . $site->getUser() . '.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) { deleteTree($staging); respond(['ok' => false, 'code' => 'OPERATION_BUSY']); }
    $rollback = [];
    try {
        $stopped = executeOperationSteps($site, $compose['stop']);
        if (!stepsSucceeded($stopped)) { deleteTree($staging); respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The rootless Compose project could not be quiesced safely.']); }
        $swapOk = true;
        foreach ($selected as $name) {
            $target = $paths['directory'] . '/' . $name . '.lance';
            $prior = $paths['directory'] . '/.panelavo-prior-' . $snapshotId . '-' . $name . '.lance';
            if (file_exists($prior) || is_link($prior)) { $swapOk = false; break; }
            $hadPrior = is_dir($target) && !is_link($target);
            if ((file_exists($target) || is_link($target)) && !$hadPrior) { $swapOk = false; break; }
            if ($hadPrior && !@rename($target, $prior)) { $swapOk = false; break; }
            if (!@rename($staging . '/' . $name . '.lance', $target)) {
                if ($hadPrior) @rename($prior, $target);
                $swapOk = false; break;
            }
            $rollback[] = ['target' => $target, 'prior' => $prior, 'hadPrior' => $hadPrior];
        }
        if (!$swapOk) {
            foreach (array_reverse($rollback) as $entry) {
                deleteTree($entry['target']);
                if ($entry['hadPrior']) @rename($entry['prior'], $entry['target']);
            }
            executeOperationSteps($site, $compose['start']);
            deleteTree($staging);
            respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The table swap could not be completed; the original tables were restored.']);
        }
        $started = executeOperationSteps($site, $compose['start']);
        $ready = stepsSucceeded($started) ? lanceReadyCheck($site, $readyPath) : ['code' => 1];
        $dataChecks = $ready['code'] === 0 ? lanceDataChecks($site, $checks) : [];
        $validated = stepsSucceeded($started) && $ready['code'] === 0
            && count(array_filter($dataChecks, static fn(array $check): bool => empty($check['passed']))) === 0;
        if (!$validated) {
            executeOperationSteps($site, $compose['stop']);
            foreach (array_reverse($rollback) as $entry) {
                deleteTree($entry['target']);
                if ($entry['hadPrior']) @rename($entry['prior'], $entry['target']);
            }
            $rollbackStart = executeOperationSteps($site, $compose['start']);
            $rollbackReady = stepsSucceeded($rollbackStart) ? lanceReadyCheck($site, $readyPath) : ['code' => 1];
            deleteTree($staging);
            respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => $rollbackReady['code'] === 0
                ? 'The restored tables failed readiness or data validation, so Panelavo restored the previous tables.'
                : 'The restored tables failed validation and the previous tables were put back, but the website did not recover its readiness gate.']);
        }
        foreach ($rollback as $entry) if ($entry['hadPrior']) deleteTree($entry['prior']);
        deleteTree($staging);
        return ['snapshotId' => $snapshotId, 'restoredTables' => $selected, 'ready' => true, 'checks' => $dataChecks, 'stop' => $stopped, 'start' => $started];
    } finally {
        flock($lock, LOCK_UN); fclose($lock);
    }
}

function manageSiteDatastore(Site $site, User $user, array $operation): array
{
    if (($operation['driver'] ?? null) !== 'lancedb') invalidBrokerRequest();
    $action = (string) ($operation['action'] ?? '');
    $path = brokerString($operation, 'path', 1, 240, '/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/');
    $paths = lanceDatastoreDirectory($site, $path);
    if ($action === 'inspect') return [
        'driver' => 'lancedb',
        'path' => $paths['relative'],
        'tables' => lanceTableInventory($paths['directory']),
        'snapshots' => listLanceSnapshots($site, $paths['relative']),
    ];
    if ($action === 'create-snapshot') return createLanceSnapshot($site, $user, $paths, $operation);
    if ($action === 'restore-snapshot') return restoreLanceSnapshot($site, $user, $paths, $operation);
    invalidBrokerRequest();
}

function runDatastoreSelfTest(): never
{
    $assert = static function (bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); };
    $tables = [['name' => 'common_users'], ['name' => 'donors_Dhaka_O_'], ['name' => 'imported_donors']];
    $assert(selectLanceTables($tables, ['*'], ['common_*']) === ['donors_Dhaka_O_', 'imported_donors'], 'exclude rules must remove matching tables');
    $assert(selectLanceTables($tables, ['donors_*', 'imported_*'], ['*_Dhaka_*']) === ['imported_donors'], 'include and exclude rules must compose deterministically');
    echo "LanceDB datastore self-test passed.\n";
    exit(0);
}

function runComposePortSelfTest(): never
{
    $config = ['services' => [
        'backend' => [
            'environment' => ['PORT' => '4000'],
            'ports' => [['target' => 4000, 'published' => '4000', 'host_ip' => '127.0.0.1']],
            'healthcheck' => ['test' => ['CMD', 'wget', '--spider', 'http://localhost:4000/api/health']],
        ],
        'frontend' => [
            'environment' => ['PORT' => '3000'],
            'ports' => [['target' => 3000, 'published' => '3000', 'host_ip' => '127.0.0.1']],
            'depends_on' => ['backend' => ['condition' => 'service_healthy']],
            'healthcheck' => ['test' => ['CMD', 'wget', '--spider', 'http://127.0.0.1:3000/login']],
        ],
        'postgres' => [
            'volumes' => [
                ['type' => 'volume', 'source' => 'postgres-data', 'target' => '/var/lib/postgresql/data', 'volume' => []],
                ['type' => 'bind', 'source' => '/srv/app', 'target' => '/app', 'bind' => ['create_host_path' => true]],
            ],
        ],
    ], 'networks' => [
        'default' => ['name' => 'example_default', 'ipam' => null],
        'empty' => ['name' => 'example_empty', 'ipam' => []],
        'private' => ['name' => 'example_private', 'ipam' => ['driver' => 'default']],
    ]];
    $routing = composePortRouting(24001, $config);
    $assert = static function (bool $condition, string $message): void {
        if (!$condition) throw new RuntimeException($message);
    };
    $assert($routing['entryService'] === 'frontend', 'frontend should be selected from the dependency graph');
    $assert($routing['containerPort'] === 3000, 'frontend container port should be 3000');
    $assert($routing['publishedPort'] === 3000, 'the original host port should be reported');
    $assert($routing['canAutoRemap'] === true, 'the mismatch should be safely remappable');
    $runtime = remapResolvedCompose($config, $routing);
    $frontendPort = $runtime['services']['frontend']['ports'][0] ?? [];
    $assert((int) ($frontendPort['published'] ?? 0) === 24001, 'frontend should publish the CloudPanel port');
    $assert(($frontendPort['host_ip'] ?? '') === '127.0.0.1', 'entry port should remain private');
    $assert((int) ($runtime['services']['backend']['ports'][0]['published'] ?? 0) === 4000, 'secondary service port should be preserved');
    $assert(!array_key_exists('ipam', $runtime['networks']['default']), 'synthetic null network IPAM should be removed');
    $assert(!array_key_exists('ipam', $runtime['networks']['empty']), 'synthetic empty network IPAM should be removed');
    $assert(($runtime['networks']['private']['ipam']['driver'] ?? '') === 'default', 'configured network IPAM should be preserved');
    $assert(!str_contains((string) json_encode($runtime), '"ipam":[]'), 'runtime JSON must not encode an empty IPAM list');
    $assert(!array_key_exists('volume', $runtime['services']['postgres']['volumes'][0]), 'synthetic empty volume mount option should be removed');
    $assert(($runtime['services']['postgres']['volumes'][1]['bind']['create_host_path'] ?? null) === true, 'configured mount options should be preserved');
    $assert(!str_contains((string) json_encode($runtime), '"volume":[]'), 'runtime JSON must not encode an empty mount option list');
    $assert(($config['services']['postgres']['volumes'][0]['volume'] ?? null) === [], 'source mount config must not be mutated');
    $assert((int) ($config['services']['frontend']['ports'][0]['published'] ?? 0) === 3000, 'source config must not be mutated');
    $assert(array_key_exists('ipam', $config['networks']['default']), 'source network config must not be mutated');

    $source = "services:\n  frontend:\n    ports:\n      - \"3000:3000\" # public entry\n    environment:\n      PORT: 3000\n";
    $aligned = rewriteComposeEntryPort(rewriteComposePorts($source), 3000, 3000, 24001);
    $assert(is_string($aligned) && str_contains($aligned, '"127.0.0.1:24001:3000" # public entry'), 'one literal entry mapping should align to the CloudPanel port');
    $assert(str_contains((string) $aligned, 'PORT: 3000'), 'the in-container application port must remain unchanged');
    $duplicate = $source . "  worker:\n    ports:\n      - \"3000:3000\"\n";
    $assert(rewriteComposeEntryPort(rewriteComposePorts($duplicate), 3000, 3000, 24001) === null, 'duplicate source mappings must remain ambiguous');

    $ambiguous = composePortRouting(24001, ['services' => [
        'alpha' => ['ports' => [['target' => 8000, 'published' => '8000']]],
        'beta' => ['ports' => [['target' => 9000, 'published' => '9000']]],
    ]]);
    $assert($ambiguous['entryService'] === null, 'ambiguous services must not be guessed');
    $assert(str_contains($ambiguous['portDetail'], 'io.panelavo.entrypoint=true'), 'ambiguity should include the repair instruction');
    echo "Compose port routing self-test passed.\n";
    exit(0);
}

function runFreshSiteScaffoldSelfTest(): never
{
    $assert = static function (bool $condition, string $message): void {
        if (!$condition) throw new RuntimeException($message);
    };
    $temporary = sys_get_temp_dir() . '/panelavo-scaffold-self-test-' . bin2hex(random_bytes(4));
    mkdir($temporary, 0700);
    mkdir($temporary . '/.well-known', 0700);
    file_put_contents($temporary . '/index.php', '<?php echo "ready";');
    $initial = freshSiteScaffoldInventory($temporary);
    $assert(is_array($initial) && count($initial) === 1, 'one generated file should be fingerprinted');
    $assert(($initial[0]['name'] ?? '') === 'index.php', 'ACME state must be excluded from the fingerprint');
    file_put_contents($temporary . '/index.php', '<?php echo "changed";');
    $changed = freshSiteScaffoldInventory($temporary);
    $assert(($initial[0]['sha256'] ?? '') !== ($changed[0]['sha256'] ?? ''), 'an edited placeholder must not match its creation fingerprint');
    mkdir($temporary . '/custom', 0700);
    $assert(freshSiteScaffoldInventory($temporary) === null, 'directories must never be treated as removable scaffolding');
    deleteTree($temporary);
    echo "Fresh-site scaffold self-test passed.\n";
    exit(0);
}

function runEnvSelfTest(): never
{
    $assert = static function (bool $condition, string $message): void {
        if (!$condition) throw new RuntimeException($message);
    };
    $parsed = parseEnvContent("# comment\nAPP_NAME=Panelavo\nexport APP_URL=\"https://example.com\"\nAPP_KEY='secret value'\nDB_PORT=3306 # inline comment\nBROKEN LINE\nESCAPED=\"a\\\"b\"\n");
    $assert($parsed['APP_NAME'] === 'Panelavo', 'plain values should parse');
    $assert($parsed['APP_URL'] === 'https://example.com', 'export prefix and double quotes should parse');
    $assert($parsed['APP_KEY'] === 'secret value', 'single-quoted values should parse');
    $assert($parsed['DB_PORT'] === '3306', 'inline comments should be stripped from unquoted values');
    $assert($parsed['ESCAPED'] === 'a"b', 'escaped quotes should unescape');
    $assert(!isset($parsed['BROKEN']), 'malformed lines should be ignored');

    $rendered = renderEnvFile("# keep me\nAPP_NAME=Old\nREMOVED=1\nAPP_NAME=Duplicate\n", [
        'APP_NAME' => 'New',
        'ADDED' => 'has spaces "and" quotes',
    ]);
    $assert(str_contains($rendered, "# keep me\n"), 'comments should survive a rewrite');
    $assert(substr_count($rendered, 'APP_NAME=') === 1, 'duplicate keys should collapse to one line');
    $assert(!str_contains($rendered, 'REMOVED'), 'removed keys should disappear');
    $assert(str_contains($rendered, 'ADDED="has spaces \\"and\\" quotes"'), 'unsafe values should be quoted and escaped');
    $assert(parseEnvContent($rendered)['ADDED'] === 'has spaces "and" quotes', 'rendered files should round-trip');
    $assert(renderEnvFile('', []) === '', 'an empty save should produce an empty file');
    $port = rewriteDotenvPort("# keep\nexport PORT=\"3000\" # app\nAPP_URL=https://example.com\n", 24001);
    $assert(is_array($port) && ($port['from'] ?? null) === 3000, 'one numeric PORT assignment should be detected');
    $assert(str_contains((string) ($port['text'] ?? ''), 'export PORT="24001" # app'), 'only the PORT value should be rewritten');
    $assert(rewriteDotenvPort("PORT=3000\nPORT=4000\n", 24001) === null, 'duplicate PORT assignments must remain ambiguous');
    $temporary = sys_get_temp_dir() . '/panelavo-port-source-self-test-' . bin2hex(random_bytes(4));
    mkdir($temporary, 0700);
    file_put_contents($temporary . '/.env', "PORT=3000\n");
    file_put_contents($temporary . '/.env.production', "PORT=4000\n");
    $hints = directPortSourceHints($temporary, 3000, ['scripts' => ['start' => 'node server.js --port 4000']], null);
    $assert(in_array('.env PORT', $hints, true), 'the primary dotenv source should be detected');
    $assert(in_array('.env.production PORT', $hints, true), 'a conflicting dotenv authority should be detected regardless of its value');
    $assert(in_array('package.json script', $hints, true), 'a hard-coded package script port should be detected regardless of its value');
    deleteTree($temporary);
    echo "Environment management self-test passed.\n";
    exit(0);
}

function runRootlessSelfTest(): never
{
    $assert = static function (bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); };
    $assert(rootlessMappedId(0, 1003, 296608) === 1003, 'container root must map to the site user');
    $assert(rootlessMappedId(1, 1003, 296608) === 296608, 'container UID 1 must map to the subordinate range start');
    $assert(rootlessMappedId(1000, 1003, 296608) === 297607, 'container UID 1000 must map with the rootless n-1 formula');
    $assert(effectiveContainerRuntimeIdentity(['uid' => 1000, 'gid' => 1000], []) === ['uid' => 1000, 'gid' => 1000], 'a non-root PID 1 must remain authoritative');
    $assert(effectiveContainerRuntimeIdentity(['uid' => 0, 'gid' => 0], [['uid' => 0, 'gid' => 0], ['uid' => 1000, 'gid' => 1000]]) === ['uid' => 1000, 'gid' => 1000], 'a unique privilege-dropped child must define the effective runtime identity');
    $assert(effectiveContainerRuntimeIdentity(['uid' => 0, 'gid' => 0], [['uid' => 0, 'gid' => 0]]) === ['uid' => 0, 'gid' => 0], 'an all-root process tree must remain root');
    $assert(effectiveContainerRuntimeIdentity(['uid' => 0, 'gid' => 0], [['uid' => 1000, 'gid' => 1000], ['uid' => 33, 'gid' => 33]]) === null, 'multiple non-root identities must remain ambiguous');
    $rows = decodeComposePsRows("{\"State\":\"running\",\"Health\":\"healthy\"}\n{\"State\":\"running\",\"Health\":\"starting\"}");
    $assert(count($rows) === 2, 'newline-delimited Compose JSON must decode every service');
    $assert(!composeMigrationRowsReady($rows, 2), 'starting health must not pass migration readiness');
    $assert(composeMigrationRowsReady([['State' => 'running', 'Health' => 'healthy'], ['State' => 'running', 'Health' => '']], 2), 'healthy services and services without healthchecks must pass readiness');
    $assert(rootlessStorageDriverReady('overlay2'), 'overlay2 must be accepted as native rootless storage');
    $assert(rootlessStorageDriverReady('overlayfs'), 'Docker 29 overlayfs must be accepted as native rootless storage');
    $assert(rootlessStorageDriverReady('fuse-overlayfs'), 'fuse-overlayfs must be accepted as the fallback storage driver');
    $assert(!rootlessStorageDriverReady('vfs'), 'unsupported storage drivers must remain blocked');
    $temporary = sys_get_temp_dir() . '/panelavo-rootless-self-test-' . bin2hex(random_bytes(4));
    mkdir($temporary, 0700);
    file_put_contents($temporary . '/data', 'ok');
    $linked = @symlink('/etc/passwd', $temporary . '/outside');
    $paths = iterator_to_array(migrationTreeEntries($temporary));
    $assert(in_array('data', array_map('basename', $paths), true), 'physical descendants must be inventoried');
    if ($linked) $assert(!in_array('outside', array_map('basename', $paths), true), 'symlinks must not be traversed or inventoried');
    if (DIRECTORY_SEPARATOR === '/') {
        $socketPath = $temporary . '/probe.sock';
        $errorCode = 0; $errorMessage = '';
        $server = @stream_socket_server('unix://' . $socketPath, $errorCode, $errorMessage);
        $assert(is_resource($server) && pathIsSocket($socketPath), 'Unix socket paths must be detected through their filesystem type');
        if (is_resource($server)) fclose($server);
        @unlink($socketPath);
    }
    @unlink($temporary . '/outside'); @unlink($temporary . '/data'); @rmdir($temporary);
    echo "Rootless Docker ownership self-test passed.\n";
    exit(0);
}

function runEndpointSelfTest(): never
{
    if (!isSafeEndpointAddress('127.0.0.1:22001', 22001)) throw new RuntimeException('IPv4 loopback rejected.');
    if (!isSafeEndpointAddress('[::1]:22001', 22001)) throw new RuntimeException('IPv6 loopback rejected.');
    foreach (['0.0.0.0:22001', '*:22001', '127.0.0.1:22002'] as $unsafe) {
        if (isSafeEndpointAddress($unsafe, 22001)) throw new RuntimeException('Unsafe endpoint address accepted.');
    }
    echo "Project endpoint self-test passed.\n";
    exit(0);
}

function brokerDirectWrapperDenied(): bool
{
    $callerUid = (int) getenv('PANELAVO_CALLER_UID');
    $account = $callerUid > 0 && function_exists('posix_getpwuid') ? posix_getpwuid($callerUid) : false;
    $username = is_array($account) ? (string) ($account['name'] ?? '') : '';
    if (!preg_match('/^[a-z_][a-z0-9_-]{0,31}$/', $username)) return false;
    $result = resourceCommand([
        '/usr/bin/sudo', '-n', '-u', $username, '--',
        '/usr/bin/sudo', '-n', '-l', '/usr/bin/clpctlWrapper',
    ], 5);
    return $result['code'] !== 0;
}

if (($argv[1] ?? '') === '--self-test-ports') runComposePortSelfTest();
if (($argv[1] ?? '') === '--self-test-scaffold') runFreshSiteScaffoldSelfTest();
if (($argv[1] ?? '') === '--self-test-env') runEnvSelfTest();
if (($argv[1] ?? '') === '--self-test-rootless') runRootlessSelfTest();
if (($argv[1] ?? '') === '--self-test-datastore') runDatastoreSelfTest();
if (($argv[1] ?? '') === '--self-test-endpoints') runEndpointSelfTest();

try {
    $encodedInput = stream_get_contents(STDIN, PANELAVO_BROKER_MAX_INPUT_BYTES + 1);
    if (!is_string($encodedInput) || strlen($encodedInput) > PANELAVO_BROKER_MAX_INPUT_BYTES) {
        respond(['ok' => false, 'code' => 'INVALID_REQUEST'], 2);
    }
    $input = json_decode($encodedInput, true, 16, JSON_THROW_ON_ERROR);
    if (!is_array($input)
        || ($input['protocolVersion'] ?? null) !== PANELAVO_BROKER_PROTOCOL_VERSION
        || getenv('PANELAVO_BROKER') !== '1') {
        respond(['ok' => false, 'code' => 'BROKER_PROTOCOL_MISMATCH'], 2);
    }
    $effectiveUid = function_exists('posix_geteuid') ? posix_geteuid() : getmyuid();
    if ($effectiveUid !== 0) respond(['ok' => false, 'code' => 'BROKER_INTEGRITY_FAILED'], 2);
    if (($input['action'] ?? '') === 'broker-health') {
        $state = databaseGatewayState();
        respond(['ok' => true, 'data' => [
            'broker' => 'panelavo',
            'protocolVersion' => PANELAVO_BROKER_PROTOCOL_VERSION,
            'privileged' => true,
            'directClpctlDenied' => brokerDirectWrapperDenied(),
            'cloudPanelAvailable' => is_readable(CLOUDPANEL_ROOT . '/vendor/autoload.php')
                && is_executable('/usr/bin/clpctl'),
            'databaseGatewayReady' => databaseGatewayReady($state) && databaseGatewayServiceReady(),
        ]]);
    }
} catch (Throwable) {
    respond(['ok' => false, 'code' => 'INVALID_REQUEST'], 2);
}

require CLOUDPANEL_ROOT . '/vendor/autoload.php';
(new Dotenv())->bootEnv(CLOUDPANEL_ROOT . '/.env');

try {
    $kernel = new Kernel($_SERVER['APP_ENV'] ?? 'prod', false);
    $kernel->boot();
    $manager = $kernel->getContainer()->get('doctrine')->getManager();
    if (($input['action'] ?? '') === 'backup-staging') {
        respond(['ok' => true, 'data' => ['directory' => backupStagingDirectory()]]);
    }
    if (in_array(($input['action'] ?? ''), ['stage-backup', 'import-backup-bundle'], true)) {
        $domain = brokerDomainValue($input['domain'] ?? null);
        $site = $manager->getRepository(Site::class)->findOneBy(['domainName' => $domain]);
        if (!$site instanceof Site) respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);
        ensureSiteProjectAccess($site);
        $lock = @fopen('/var/lock/panelavo-operations-' . $site->getUser() . '.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) respond(['ok' => false, 'code' => 'OPERATION_BUSY']);
        $id = (string) ($input['id'] ?? '');
        if (($input['action'] ?? '') === 'stage-backup') {
            respond(['ok' => true, 'data' => stageBackupBundle($site, $id)]);
        }
        importBackupBundle($site, $id, (string) ($input['path'] ?? ''));
        respond(['ok' => true, 'data' => ['backupId' => $id]]);
    }
    if (($input['action'] ?? '') === 'scheduled-backup') {
        $domain = brokerDomainValue($input['domain'] ?? null);
        $site = $manager->getRepository(Site::class)->findOneBy(['domainName' => $domain]);
        if (!$site instanceof Site) respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);
        $retention = $input['retention'] ?? null;
        if (!is_int($retention) || $retention < 1 || $retention > 100) invalidBrokerRequest();
        ensureSiteProjectAccess($site);
        $lock = @fopen('/var/lock/panelavo-operations-' . $site->getUser() . '.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) respond(['ok' => false, 'code' => 'OPERATION_BUSY']);
        $section = createBackup($site, [
            'files' => true,
            'retention' => $retention,
            'note' => 'Scheduled backup',
        ]);
        respond(['ok' => true, 'data' => [
            'backupId' => $section['items'][0]['id'] ?? null,
        ]]);
    }
    if (($input['action'] ?? '') === 'database-gateway-reconcile') {
        respond(['ok' => true, 'data' => reconcileDatabaseGateway($manager)]);
    }
    if (($input['action'] ?? '') === 'database-gateway-ca') {
        $state = databaseGatewayState();
        $certificate = @file_get_contents(PANELAVO_DATABASE_GATEWAY_ROOT . '/proxysql/proxysql-ca.pem');
        if (!is_string($certificate) || !str_contains($certificate, 'BEGIN CERTIFICATE')) {
            respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);
        }
        respond(['ok' => true, 'data' => [
            'certificate' => $certificate,
            'tlsTrust' => (string) ($state['tlsTrust'] ?? 'panelavo-ca'),
            'suffix' => (string) ($state['suffix'] ?? ''),
        ]]);
    }
    if (($input['action'] ?? '') === 'storage-hygiene') {
        respond(['ok' => true, 'data' => runStorageHygiene($manager)]);
    }
    if (($input['action'] ?? '') === 'host-maintenance') {
        respond(['ok' => true, 'data' => hostMaintenanceStatus(true)]);
    }
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

        case 'manage-mfa':
            if (!method_exists($user, 'setMfaSecret')) {
                respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'This CloudPanel release does not support MFA changes.']);
            }
            $operation = $input['operation'] ?? [];
            $mfaAction = (string) ($operation['action'] ?? '');
            $code = preg_replace('/\s+/', '', (string) ($operation['code'] ?? ''));
            if (preg_match('/^[0-9]{6}$/', $code) !== 1) respond(['ok' => false, 'code' => 'INVALID_TWO_FACTOR_CODE']);
            $authenticator = new MfaAuthenticator();
            if ($mfaAction === 'enable') {
                if ($user->hasMfaEnabled()) respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'Two-factor authentication is already enabled.']);
                $secret = strtoupper((string) ($operation['secret'] ?? ''));
                if (preg_match('/^[A-Z2-7]{32}$/', $secret) !== 1 || !$authenticator->verifyCode($secret, $code)) {
                    respond(['ok' => false, 'code' => 'INVALID_TWO_FACTOR_CODE']);
                }
                $user->setMfaSecret($secret);
            } elseif ($mfaAction === 'disable') {
                if (!$user->hasMfaEnabled() || !$authenticator->verifyCode($user->getMfaSecret(), $code)) {
                    respond(['ok' => false, 'code' => 'INVALID_TWO_FACTOR_CODE']);
                }
                $user->setMfaSecret(null);
            } else {
                respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
            }
            $manager->flush();
            respond(['ok' => true, 'user' => publicUser($user)]);

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

        case 'clpctl-user-add':
            if ($user->getRole() !== User::ROLE_ADMIN) respond(['ok' => false, 'code' => 'FORBIDDEN']);
            $targetUsername = strtolower(brokerString($input, 'targetUsername', 2, 64, '/^[A-Za-z0-9._-]+$/'));
            $email = brokerString($input, 'email', 3, 254);
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) invalidBrokerRequest();
            $firstName = brokerString($input, 'firstName', 0, 64);
            $lastName = brokerString($input, 'lastName', 0, 64);
            if (preg_match('/[\x00-\x1f\x7f]/', $firstName . $lastName)) invalidBrokerRequest();
            $password = brokerPassword($input['password'] ?? null);
            $role = $input['role'] ?? null;
            if (!is_string($role) || !in_array($role, ['admin', 'site-manager', 'user'], true)) invalidBrokerRequest();
            $timezone = brokerString($input, 'timezone', 1, 64, '/^[A-Za-z0-9_+\/-]+$/');
            $sites = $input['sites'] ?? null;
            if (!is_array($sites) || count($sites) > 100) invalidBrokerRequest();
            $siteDomains = [];
            foreach ($sites as $domain) $siteDomains[] = brokerDomainValue($domain);
            if ($role === 'user' && !$siteDomains) invalidBrokerRequest();
            finishClpctl(runClpctl([
                'user:add',
                '--userName=' . $targetUsername,
                '--email=' . $email,
                '--firstName=' . $firstName,
                '--lastName=' . $lastName,
                '--password=' . $password,
                '--role=' . $role,
                '--sites=' . implode(',', array_values(array_unique($siteDomains))),
                '--timezone=' . $timezone,
                '--status=1',
            ]));

        case 'clpctl-user-reset-password':
            $targetUsername = strtolower(brokerString($input, 'targetUsername', 2, 64, '/^[A-Za-z0-9._-]+$/'));
            $selfService = ($input['selfService'] ?? false) === true;
            if ($user->getRole() !== User::ROLE_ADMIN
                && !($selfService && strtolower((string) $user->getUserName()) === $targetUsername)) {
                respond(['ok' => false, 'code' => 'FORBIDDEN']);
            }
            finishClpctl(runClpctl([
                'user:reset:password',
                '--userName=' . $targetUsername,
                '--password=' . brokerPassword($input['password'] ?? null),
            ]));

        case 'clpctl-user-delete':
            if ($user->getRole() !== User::ROLE_ADMIN) respond(['ok' => false, 'code' => 'FORBIDDEN']);
            $targetUsername = strtolower(brokerString($input, 'targetUsername', 2, 64, '/^[A-Za-z0-9._-]+$/'));
            if (strtolower((string) $user->getUserName()) === $targetUsername) invalidBrokerRequest();
            finishClpctl(runClpctl(['user:delete', '--userName=' . $targetUsername, '--force']));

        case 'clpctl-vhost-templates':
            $templateResult = runClpctl(['vhost-templates:list'], 30);
            if ($templateResult['code'] !== 0) finishClpctl($templateResult);
            $templates = [];
            foreach (preg_split('/\R/', (string) $templateResult['stdout']) ?: [] as $line) {
                if (!preg_match('/^\|/', $line) || preg_match('/Name\s+\|/', $line)) continue;
                $name = trim((string) (explode('|', $line)[1] ?? ''));
                if ($name !== '' && preg_match('/^[A-Za-z0-9 ._-]{1,100}$/', $name)) $templates[] = $name;
            }
            respond(['ok' => true, 'data' => [
                'templates' => array_values(array_unique($templates)),
                'reservedPorts' => hostReservedPorts($manager),
            ]]);

        case 'clpctl-site-create':
            $panelAdmin = ($input['panelAdmin'] ?? false) === true;
            if (!in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true) && !$panelAdmin) {
                respond(['ok' => false, 'code' => 'FORBIDDEN']);
            }
            $siteInput = $input['site'] ?? null;
            if (!is_array($siteInput)) invalidBrokerRequest();
            $type = $siteInput['type'] ?? null;
            if (!is_string($type) || !in_array($type, ['php', 'nodejs', 'static', 'python', 'reverse-proxy'], true)) {
                invalidBrokerRequest();
            }
            $allowedKeys = ['type', 'domain', 'siteUser', 'siteUserPassword'];
            $allowedKeys = array_merge($allowedKeys, match ($type) {
                'php' => ['phpVersion', 'vhostTemplate'],
                'nodejs' => ['nodeVersion', 'appPort'],
                'python' => ['pythonVersion', 'appPort'],
                'reverse-proxy' => ['reverseProxyUrl'],
                default => [],
            });
            if (array_diff(array_keys($siteInput), $allowedKeys)) invalidBrokerRequest();
            $domain = brokerDomainValue($siteInput['domain'] ?? null);
            $siteUser = $siteInput['siteUser'] ?? null;
            if (!is_string($siteUser) || preg_match('/^[A-Za-z_][A-Za-z0-9._-]{1,63}$/', $siteUser) !== 1) invalidBrokerRequest();
            $requestedPort = requestedSitePort($siteInput);
            if ($requestedPort !== null && in_array($requestedPort, hostReservedPorts($manager), true)) {
                respond([
                    'ok' => false,
                    'code' => 'INVALID_REQUEST',
                    'message' => 'Application port ' . $requestedPort . ' is already reserved or listening on this server.',
                ]);
            }
            if ($type === 'php') {
                foreach ($manager->getRepository(Site::class)->findAll() as $existingSite) {
                    if (!$existingSite instanceof Site || $existingSite->getType() === Site::TYPE_PHP) continue;
                    $legacyPort = expectedSitePort($existingSite);
                    if ($legacyPort !== null && $legacyPort >= 20000 && $legacyPort <= 29999) {
                        respond([
                            'ok' => false,
                            'code' => 'INVALID_REQUEST',
                            'message' => 'Migrate legacy application port ' . $legacyPort . ' outside the CloudPanel PHP-FPM allocation range before creating another PHP website.',
                        ]);
                    }
                }
            }
            $args = [
                'site:add:' . $type,
                '--domainName=' . $domain,
                '--siteUser=' . $siteUser,
                '--siteUserPassword=' . brokerPassword($siteInput['siteUserPassword'] ?? null),
            ];
            if ($type === 'php') {
                $template = $siteInput['vhostTemplate'] ?? null;
                if (!is_string($template) || preg_match('/^[A-Za-z0-9 ._-]{1,100}$/', $template) !== 1) invalidBrokerRequest();
                $args[] = '--phpVersion=' . brokerRuntimeValue($siteInput['phpVersion'] ?? null);
                $args[] = '--vhostTemplate=' . $template;
            } elseif ($type === 'nodejs') {
                $args[] = '--nodejsVersion=' . brokerRuntimeValue($siteInput['nodeVersion'] ?? null);
                $args[] = '--appPort=' . brokerPortValue($siteInput['appPort'] ?? null);
            } elseif ($type === 'python') {
                $args[] = '--pythonVersion=' . brokerRuntimeValue($siteInput['pythonVersion'] ?? null);
                $args[] = '--appPort=' . brokerPortValue($siteInput['appPort'] ?? null);
            } elseif ($type === 'reverse-proxy') {
                $url = $siteInput['reverseProxyUrl'] ?? null;
                if (!is_string($url) || strlen($url) > 2048 || preg_match('/[\r\n\x00-\x1f\x7f]/', $url)) invalidBrokerRequest();
                $parts = parse_url($url);
                if (!is_array($parts)
                    || !in_array(strtolower((string) ($parts['scheme'] ?? '')), ['http', 'https'], true)
                    || empty($parts['host'])
                    || isset($parts['user'])
                    || isset($parts['pass'])) {
                    invalidBrokerRequest();
                }
                $args[] = '--reverseProxyUrl=' . $url;
            }
            $createResult = runClpctl($args);
            if ($createResult['code'] !== 0) finishClpctl($createResult);
            $createdSite = $manager->getRepository(Site::class)->findOneBy(['domainName' => $domain]);
            if (!$createdSite instanceof Site) {
                respond(['ok' => false, 'code' => 'CLPCTL_FAILED', 'message' => 'The created website record could not be loaded.']);
            }
            if ($createdSite->getType() === Site::TYPE_PHP) captureFreshSiteScaffold($createdSite);
            respond(['ok' => true, 'site' => publicSite($createdSite)]);

        case 'clpctl-site-delete':
            $domain = brokerDomainValue($input['domain'] ?? null);
            $site = requireSiteWriter($manager, $user, $domain, ($input['panelAdmin'] ?? false) === true);
            $gatewayState = databaseGatewayState();
            foreach ($site->getDatabases()->toArray() as $database) {
                $endpoint = $gatewayState['endpoints'][(string) $database->getId()] ?? null;
                if (is_array($endpoint)) revokeDatabaseGatewayEndpoint($manager, $database, $endpoint, $gatewayState);
            }
            cleanupRootlessDockerBeforeSiteDelete($site);
            $deleteResult = runClpctl(['site:delete', '--domainName=' . $domain, '--force']);
            if ($deleteResult['code'] !== 0) finishClpctl($deleteResult);
            $scaffoldPath = freshSiteScaffoldPath($site, false);
            if ($scaffoldPath) @unlink($scaffoldPath);
            $portBackupDirectory = portBackupDirectory($site, false);
            if ($portBackupDirectory && is_dir($portBackupDirectory)) deleteTree($portBackupDirectory);
            finishClpctl($deleteResult);

        case 'clpctl-db-add':
            $domain = brokerDomainValue($input['domain'] ?? null);
            requireSiteWriter($manager, $user, $domain, ($input['panelAdmin'] ?? false) === true);
            $databaseName = brokerString($input, 'databaseName', 2, 50, '/^[A-Za-z][A-Za-z0-9-]+$/');
            $databaseUsername = brokerString($input, 'databaseUsername', 2, 50, '/^[A-Za-z][A-Za-z0-9-]+$/');
            finishClpctl(runClpctl([
                'db:add',
                '--domainName=' . $domain,
                '--databaseName=' . $databaseName,
                '--databaseUserName=' . $databaseUsername,
                '--databaseUserPassword=' . brokerPassword($input['password'] ?? null),
            ]));

        case 'clpctl-db-delete':
            $domain = brokerDomainValue($input['domain'] ?? null);
            $site = requireSiteWriter($manager, $user, $domain, ($input['panelAdmin'] ?? false) === true);
            $databaseName = brokerString($input, 'databaseName', 2, 50, '/^[A-Za-z][A-Za-z0-9-]+$/');
            if (!in_array($databaseName, siteDatabaseNames($site), true)) respond(['ok' => false, 'code' => 'FORBIDDEN']);
            $database = databaseGatewayDatabase($site, $databaseName);
            $gatewayState = databaseGatewayState();
            $endpoint = $database ? ($gatewayState['endpoints'][(string) $database->getId()] ?? null) : null;
            if ($database && is_array($endpoint)) revokeDatabaseGatewayEndpoint($manager, $database, $endpoint, $gatewayState);
            finishClpctl(runClpctl(['db:delete', '--databaseName=' . $databaseName, '--force']));

        case 'database-gateway':
            $domain = brokerDomainValue($input['domain'] ?? null);
            $site = requireSiteWriter($manager, $user, $domain, ($input['panelAdmin'] ?? false) === true);
            $operation = $input['operation'] ?? null;
            if (!is_array($operation) || count($operation) > 10) invalidBrokerRequest();
            try {
                respond(['ok' => true, 'data' => manageDatabaseGateway($manager, $site, $operation)]);
            } catch (RuntimeException $error) {
                respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => $error->getMessage()]);
            }

        case 'db-signon':
            // One-time phpMyAdmin sign-on: writes the database user's
            // credentials into an expiring, unguessable token file owned by
            // the database-manager site user, where that site's signon.php
            // consumes it exactly once. The credentials never reach the
            // browser — only the random token does. The manager domain comes
            // from the panel's server-side configuration (never the browser)
            // and must resolve to an existing CloudPanel site; everything
            // else (site user, home) is derived from that authoritative
            // record.
            $domain = brokerDomainValue($input['domain'] ?? null);
            $site = requireSiteWriter($manager, $user, $domain, ($input['panelAdmin'] ?? false) === true);
            $databaseName = brokerString($input, 'databaseName', 2, 50, '/^[A-Za-z][A-Za-z0-9-]+$/');
            $managerDomain = brokerDomainValue($input['managerDomain'] ?? null);
            $database = null;
            foreach ($site->getDatabases()->toArray() as $candidate) {
                if ((string) $candidate->getName() === $databaseName) { $database = $candidate; break; }
            }
            if (!$database) respond(['ok' => false, 'code' => 'FORBIDDEN']);
            $gatewayState = databaseGatewayState();
            $remoteUsername = (string) (($gatewayState['endpoints'][(string) $database->getId()]['username'] ?? ''));
            $databaseUser = null;
            foreach ($database->getUsers()->toArray() as $candidate) {
                if ((string) $candidate->getUserName() !== $remoteUsername) { $databaseUser = $candidate; break; }
            }
            if (!$databaseUser) respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'This database has no user to sign in with.']);
            $databasePassword = $databaseUser->getDecryptedPassword();
            if (!is_string($databasePassword) || $databasePassword === '') {
                respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The database user credentials could not be read.']);
            }
            $managerSite = $manager->getRepository(Site::class)->findOneBy(['domainName' => $managerDomain]);
            if (!$managerSite instanceof Site) respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The database manager site was not found.']);
            $managerUser = (string) $managerSite->getUser();
            $managerHome = '/home/' . $managerUser;
            if (!preg_match('/^[a-z_][a-z0-9_-]{0,31}$/', $managerUser) || !is_dir($managerHome)) {
                respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The database manager site user is invalid.']);
            }
            $signonDir = $managerHome . '/.pma-signon';
            if (is_link($signonDir)) respond(['ok' => false, 'code' => 'BROKER_INTEGRITY_FAILED'], 1);
            if (!is_dir($signonDir)) {
                if (!mkdir($signonDir, 0700)) respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The sign-on directory could not be created.']);
                chown($signonDir, $managerUser);
                chgrp($signonDir, $managerUser);
            }
            foreach (glob($signonDir . '/*.json') ?: [] as $stale) {
                if (is_link($stale)) continue;
                $staleData = json_decode((string) @file_get_contents($stale), true);
                if (!is_array($staleData) || (int) ($staleData['expires'] ?? 0) < time()) @unlink($stale);
            }
            $signonToken = bin2hex(random_bytes(32));
            $tokenFile = $signonDir . '/' . $signonToken . '.json';
            $tokenPayload = json_encode([
                'user' => (string) $databaseUser->getUserName(),
                'password' => $databasePassword,
                'db' => $databaseName,
                'expires' => time() + 60,
            ]);
            if (@file_put_contents($tokenFile, $tokenPayload) === false) {
                respond(['ok' => false, 'code' => 'SITE_UPDATE_FAILED', 'message' => 'The sign-on token could not be written.']);
            }
            chmod($tokenFile, 0600);
            chown($tokenFile, $managerUser);
            chgrp($tokenFile, $managerUser);
            respond(['ok' => true, 'data' => ['token' => $signonToken, 'db' => $databaseName]]);

        case 'clpctl-cert-install':
            $domain = brokerDomainValue($input['domain'] ?? null);
            requireSiteWriter($manager, $user, $domain, ($input['panelAdmin'] ?? false) === true);
            $names = $input['subjectAlternativeNames'] ?? null;
            if (!is_array($names) || count($names) > 20) invalidBrokerRequest();
            $san = [];
            foreach ($names as $name) $san[] = brokerDomainValue($name);
            $args = ['lets-encrypt:install:certificate', '--domainName=' . $domain];
            if ($san) $args[] = '--subjectAlternativeName=' . implode(',', array_values(array_unique($san)));
            finishClpctl(runClpctl($args));

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

        case 'server-storage':
            if (!in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true)) respond(['ok' => false, 'code' => 'FORBIDDEN']);
            respond(['ok' => true, 'data' => serverStorage($manager, ($input['refresh'] ?? false) === true)]);

        case 'server-storage-reclaim':
            if ($user->getRole() !== User::ROLE_ADMIN) respond(['ok' => false, 'code' => 'FORBIDDEN']);
            respond(['ok' => true, 'data' => reclaimServerBuildCache($manager)]);

        case 'server-info':
            if (!in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true)) respond(['ok' => false, 'code' => 'FORBIDDEN']);
            respond(['ok' => true, 'data' => serverInfo()]);

        case 'site':
            $site = authorizedSite(
                $manager,
                $user,
                (string) ($input['domain'] ?? '')
            );
            ensureSiteProjectAccess($site);
            respond(['ok' => true, 'site' => publicSite($site)]);

        case 'site-section':
            $site = authorizedSite($manager, $user, (string) ($input['domain'] ?? ''));
            ensureSiteProjectAccess($site);
            $section = (string) ($input['section'] ?? '');
            $data = match ($section) {
                'vhost' => ['content' => @file_get_contents('/etc/nginx/sites-enabled/' . $site->getDomainName() . '.conf') ?: ''],
                'databases' => databaseGatewaySection($site),
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
                'env' => envSection($site),
                'backups' => backupsSection($site),
                'terminal' => [
                    'user' => $site->getUser(),
                    'home' => '/home/' . $site->getUser(),
                    'root' => siteRootPath($site),
                ],
                'cron-jobs' => ['sitePath' => siteRootPath($site), 'items' => array_map(fn($item) => ['id' => (string) $item->getId(), 'schedule' => $item->getSchedule(), 'command' => $item->getCommand(), 'expression' => $item->getCrontabExpression()], $site->getCronJobs()->toArray())],
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
            ensureSiteProjectAccess($site);
            $section = (string) ($input['section'] ?? '');
            $operation = $input['operation'] ?? [];
            $action = (string) ($operation['action'] ?? '');
            $model = $updater = null;
            if (!in_array($section, ['file-manager', 'logs', 'git', 'actions', 'env', 'terminal', 'backups'], true) && !($section === 'users' && $action === 'generate-keypair')) {
                [$model, $updater] = siteModel($site);
            }

            if ($section === 'git') {
                $ref = (string) ($operation['branch'] ?? '');
                if ($ref !== '' && !preg_match('/^[A-Za-z0-9._\/-]{1,200}$/', $ref)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                if ($action === 'clone') {
                    $url = trim((string) ($operation['url'] ?? '')); if (!preg_match('#^(https://|git@)[^\s]+$#', $url)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    // Clone into Panelavo's configured application root,
                    // creating it first when it has not been materialized yet.
                    // The CloudPanel serving root may be a child such as public/.
                    $rootPath = siteRootPath($site);
                    if (!is_dir($rootPath)) {
                        if (!mkdir($rootPath, 0755, true)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                        chown($rootPath, $site->getUser()); chgrp($rootPath, $site->getUser());
                    }
                    $root = realpath($rootPath);
                    $entries = $root ? array_values(array_diff(scandir($root) ?: [], ['.', '..'])) : [];
                    $contentEntries = array_values(array_diff($entries, ['.well-known']));
                    if (!$root
                        || (in_array('.well-known', $entries, true)
                            && (is_link($root . '/.well-known') || !is_dir($root . '/.well-known')))) {
                        respond(['ok' => false, 'code' => 'DIRECTORY_NOT_EMPTY']);
                    }
                    $scaffold = $contentEntries ? loadFreshSiteScaffold($site, $root) : null;
                    if ($contentEntries && !$scaffold) respond(['ok' => false, 'code' => 'DIRECTORY_NOT_EMPTY']);

                    // Always clone into a temporary child first. The original
                    // scaffold and ACME directory stay untouched until Git has
                    // fetched and checked out the complete repository.
                    $temporary = '.panelavo-clone-' . bin2hex(random_bytes(8));
                    $temporaryPath = $root . '/' . $temporary;
                    $clone = runGit($site, array_values(array_filter([
                        'clone', $ref ? '--branch' : null, $ref ?: null, $url, $temporary,
                    ])), true);
                    if ($clone['code'] !== 0) {
                        if (is_dir($temporaryPath)) deleteTree($temporaryPath);
                        respond(['ok' => false, 'code' => 'GIT_FAILED', 'message' => trim($clone['stderr'] ?: $clone['stdout'])]);
                    }

                    $clonedEntries = array_values(array_diff(scandir($temporaryPath) ?: [], ['.', '..']));
                    if (!in_array('.git', $clonedEntries, true)) {
                        deleteTree($temporaryPath);
                        respond(['ok' => false, 'code' => 'GIT_FAILED']);
                    }
                    $scaffoldNames = $scaffold
                        ? array_map(static fn(array $file): string => (string) ($file['name'] ?? ''), $scaffold['files'])
                        : [];
                    foreach ($clonedEntries as $name) {
                        if ((file_exists($root . '/' . $name) || is_link($root . '/' . $name))
                            && !in_array($name, $scaffoldNames, true)) {
                            deleteTree($temporaryPath);
                            respond(['ok' => false, 'code' => 'GIT_FAILED', 'message' => 'The repository conflicts with preserved website files.']);
                        }
                    }

                    $scaffoldBackup = null;
                    $stagedScaffold = [];
                    if ($scaffold) {
                        // Recheck the exact hashes after the network operation;
                        // an edited or newly added file cancels the promotion.
                        $scaffold = loadFreshSiteScaffold($site, $root, [$temporary]);
                        if (!$scaffold) {
                            deleteTree($temporaryPath);
                            respond(['ok' => false, 'code' => 'DIRECTORY_NOT_EMPTY']);
                        }
                        $scaffoldBackup = $root . '/.panelavo-scaffold-' . bin2hex(random_bytes(8));
                        if (!mkdir($scaffoldBackup, 0700)) {
                            deleteTree($temporaryPath);
                            respond(['ok' => false, 'code' => 'GIT_FAILED']);
                        }
                        foreach ($scaffold['files'] as $file) {
                            $name = (string) ($file['name'] ?? '');
                            if ($name === '' || !@rename($root . '/' . $name, $scaffoldBackup . '/' . $name)) {
                                $restored = true;
                                foreach (array_reverse($stagedScaffold) as $staged) {
                                    if (!@rename($scaffoldBackup . '/' . $staged, $root . '/' . $staged)) $restored = false;
                                }
                                deleteTree($temporaryPath);
                                if ($restored) deleteTree($scaffoldBackup);
                                respond([
                                    'ok' => false,
                                    'code' => $restored ? 'GIT_FAILED' : 'SITE_UPDATE_FAILED',
                                    'message' => $restored
                                        ? 'The original website files could not be staged and were restored.'
                                        : 'The original website files remain in protected staging because automatic restoration could not complete.',
                                ]);
                            }
                            $stagedScaffold[] = $name;
                        }
                    }

                    $promoted = [];
                    $promotionOk = true;
                    foreach ($clonedEntries as $name) {
                        if (!@rename($temporaryPath . '/' . $name, $root . '/' . $name)) {
                            $promotionOk = false;
                            break;
                        }
                        $promoted[] = $name;
                    }
                    if (!$promotionOk) {
                        $restored = true;
                        foreach (array_reverse($promoted) as $name) {
                            if (!@rename($root . '/' . $name, $temporaryPath . '/' . $name)) $restored = false;
                        }
                        foreach (array_reverse($stagedScaffold) as $name) {
                            if (!@rename($scaffoldBackup . '/' . $name, $root . '/' . $name)) $restored = false;
                        }
                        if ($restored) {
                            if (is_dir($temporaryPath)) deleteTree($temporaryPath);
                            if ($scaffoldBackup && is_dir($scaffoldBackup)) deleteTree($scaffoldBackup);
                        }
                        respond([
                            'ok' => false,
                            'code' => $restored ? 'GIT_FAILED' : 'SITE_UPDATE_FAILED',
                            'message' => $restored
                                ? 'The repository checkout could not be promoted; the original files were restored.'
                                : 'Repository promotion failed and protected staging was retained because automatic restoration could not complete.',
                        ]);
                    }
                    @rmdir($temporaryPath);
                    if ($scaffoldBackup) {
                        deleteTree($scaffoldBackup);
                        @unlink((string) $scaffold['path']);
                    }
                } elseif ($action === 'init') runGit($site, ['init']);
                elseif ($action === 'set-remote') {
                    $url = trim((string) ($operation['url'] ?? '')); if (!preg_match('#^(https://|git@)[^\s]+$#', $url)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    runGit($site, ['remote', 'remove', 'origin'], true); runGit($site, ['remote', 'add', 'origin', $url]);
                } elseif ($action === 'fetch') runGit($site, ['fetch', '--prune', 'origin']);
                elseif ($action === 'pull') {
                    $hookOperations = $operation['deployOperations'] ?? [];
                    if (!is_array($hookOperations) || count($hookOperations) > 10) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    $allowedHooks = [
                        'node-install', 'node-run', 'npm-install', 'npm-ci', 'npm-run',
                        'composer-install', 'composer-install-production', 'composer-validate',
                        'python-create-venv', 'python-install', 'pip-install',
                        'artisan-optimize', 'artisan-optimize-clear', 'artisan-migrate', 'artisan-storage-link', 'artisan-queue-restart',
                        'symfony-cache-clear', 'wp-cache-flush', 'wp-cron-run', 'django-check-deploy', 'django-migrate', 'django-collectstatic',
                        'compose-validate', 'compose-pull', 'compose-deploy', 'compose-up', 'compose-restart', 'compose-ps',
                        'pm2-start', 'pm2-restart', 'pm2-restart-one', 'pm2-save', 'upstream-check',
                    ];
                    $normalizedHooks = [];
                    foreach ($hookOperations as $hookOperation) {
                        if (!is_array($hookOperation) || array_diff(array_keys($hookOperation), ['command', 'script', 'name'])) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                        $command = (string) ($hookOperation['command'] ?? '');
                        if (!in_array($command, $allowedHooks, true)) respond(['ok' => false, 'code' => 'INVALID_ACTION']);
                        $normalizedHooks[] = $hookOperation;
                    }
                    $lock = @fopen('/var/lock/panelavo-operations-' . $site->getUser() . '.lock', 'c');
                    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) respond(['ok' => false, 'code' => 'OPERATION_BUSY']);
                    $dirty = gitChanges($site) !== [];
                    if ($dirty) runGit($site, ['stash', 'push', '--include-untracked', '-m', 'panelavo-auto-stash-before-pull']);
                    $pull = runGit($site, $ref ? ['pull', '--ff-only', 'origin', $ref] : ['pull', '--ff-only'], true);
                    if ($pull['code'] !== 0) {
                        if ($dirty) runGit($site, ['stash', 'pop'], true);
                        respond(['ok' => false, 'code' => 'GIT_FAILED', 'message' => trim($pull['stderr'] ?: $pull['stdout'])]);
                    }
                    if ($dirty) {
                        $restore = runGit($site, ['stash', 'pop'], true);
                        $notice = $restore['code'] === 0
                            ? 'Pulled remote changes and restored your local changes.'
                            : 'Pulled remote changes, but some local changes conflicted. Resolve the marked files; the safety stash was kept.';
                    }
                    if ($normalizedHooks && (!$dirty || $restore['code'] === 0)) {
                        // Pull may change manifests, scripts, or Compose files.
                        // Resolve the saved identifiers from the newly pulled
                        // tree while the same site lock is still held.
                        $hookSteps = [];
                        $state = operationsState($site, $user);
                        foreach ($normalizedHooks as $hookOperation) {
                            $command = (string) $hookOperation['command'];
                            $hookSteps[] = resolveOperationStep($state, $command, $hookOperation);
                            if (!empty($state['expectedPort']) && in_array($command, ['compose-up', 'compose-deploy', 'compose-restart'], true)) {
                                $hookSteps[] = resolveOperationStep($state, 'compose-port-verify', []);
                            } elseif (!empty($state['expectedPort']) && in_array($command, ['pm2-start', 'pm2-restart', 'pm2-restart-one'], true)) {
                                $hookSteps[] = resolveOperationStep($state, 'runtime-port-verify', []);
                            }
                        }
                        foreach ($hookSteps as $stepDefinition) if (!empty($stepDefinition['asRoot'])) respond(['ok' => false, 'code' => 'FORBIDDEN']);
                        $startedAt = gmdate(DATE_ATOM);
                        $hookResults = executeOperationSteps($site, $hookSteps);
                        $lastHook = end($hookResults);
                        $deployment = [
                            'exitCode' => $lastHook['exitCode'], 'timedOut' => $lastHook['timedOut'],
                            'startedAt' => $startedAt, 'finishedAt' => gmdate(DATE_ATOM),
                            'steps' => $hookResults,
                        ];
                        if ($lastHook['exitCode'] !== 0) $notice = 'Remote changes were pulled, but the post-pull deployment stopped on a failed operation.';
                    }
                    flock($lock, LOCK_UN); fclose($lock);
                }
                elseif ($action === 'push') runGit($site, $ref ? ['push', '-u', 'origin', $ref] : ['push']);
                elseif ($action === 'checkout') runGit($site, ['checkout', $ref]);
                elseif ($action === 'commit') { $message = trim((string) ($operation['message'] ?? '')); if ($message === '' || strlen($message) > 500) respond(['ok' => false, 'code' => 'INVALID_REQUEST']); runGit($site, ['add', '--all']); runGit($site, ['commit', '-m', $message]); }
                elseif ($action === 'diff') {
                    $change = gitChangedPath($site, (string) ($operation['path'] ?? ''));
                    respond(['ok' => true, 'data' => gitSection($site, $change)]);
                } elseif ($action === 'discard') {
                    $change = gitChangedPath($site, (string) ($operation['path'] ?? ''));
                    $path = (string) $change['path'];
                    if ($change['status'] === '??') runGit($site, ['clean', '-fd', '--', $path]);
                    else {
                        $paths = array_values(array_filter([$path, (string) ($change['originalPath'] ?? '')]));
                        $hasHead = runGit($site, ['rev-parse', '--verify', 'HEAD'], true)['code'] === 0;
                        if ($hasHead) runGit($site, array_merge(['restore', '--source=HEAD', '--staged', '--worktree', '--'], $paths));
                        else { runGit($site, array_merge(['rm', '-rf', '--cached', '--'], $paths), true); foreach ($paths as $discardPath) runGit($site, ['clean', '-fd', '--', $discardPath]); }
                    }
                } elseif ($action === 'discard-all') {
                    $hasHead = runGit($site, ['rev-parse', '--verify', 'HEAD'], true)['code'] === 0;
                    if ($hasHead) runGit($site, ['reset', '--hard', 'HEAD']);
                    else runGit($site, ['rm', '-rf', '--cached', '.'], true);
                    runGit($site, ['clean', '-fd']);
                }
                else respond(['ok' => false, 'code' => 'INVALID_ACTION']);
                $gitData = gitSection($site, null, $notice ?? null);
                if (isset($deployment)) $gitData['deployment'] = $deployment;
                respond(['ok' => true, 'data' => $gitData]);
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
                    $fix = (string) ($operation['fix'] ?? '');
                    $results = [];
                    // The per-user rootless runtime self-init only starts the
                    // requesting site user's own daemon (never apt/usermod), so a
                    // site-write user may run it — the manage-section gate above
                    // already proved site-write access — and it is serialized per
                    // site like the contained port-source repair. Every other fix
                    // changes shared APT/systemd host state and stays Super
                    // Admin-only, serialized host-wide.
                    $selfService = in_array($fix, ['initialize-rootless-runtime', 'align-application-port'], true);
                    if (!$selfService && $user->getRole() !== User::ROLE_ADMIN) respond(['ok' => false, 'code' => 'FORBIDDEN']);
                    $lockPath = $selfService
                        ? '/var/lock/panelavo-operations-' . $site->getUser() . '.lock'
                        : '/var/lock/panelavo-host-fix.lock';
                    $runner = static function () use ($site, $fix, &$results): void { executeFix($site, $fix, $results); };
                    $lock = @fopen($lockPath, 'c');
                    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) respond(['ok' => false, 'code' => 'OPERATION_BUSY']);
                    $startedAt = gmdate(DATE_ATOM);
                    $runner();
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
                $migrationCommands = ['prepare-rootless-migration', 'cutover-rootless-migration', 'recover-rootless-migration'];
                if ($action === 'run' && in_array((string) ($operation['command'] ?? ''), $migrationCommands, true)) {
                    if ($user->getRole() !== User::ROLE_ADMIN) respond(['ok' => false, 'code' => 'FORBIDDEN']);
                    $lock = @fopen('/var/lock/panelavo-operations-' . $site->getUser() . '.lock', 'c');
                    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) respond(['ok' => false, 'code' => 'OPERATION_BUSY']);
                    $startedAt = gmdate(DATE_ATOM);
                    try {
                        $command = (string) $operation['command'];
                        $outcome = match ($command) {
                            'prepare-rootless-migration' => prepareRootlessMigration($site, (string) ($operation['name'] ?? '')),
                            'cutover-rootless-migration' => cutoverRootlessMigration($site),
                            'recover-rootless-migration' => recoverRootlessMigration($site),
                        };
                    } finally {
                        flock($lock, LOCK_UN); fclose($lock);
                    }
                    $results = (array) ($outcome['steps'] ?? []);
                    $last = end($results) ?: ['exitCode' => 1, 'timedOut' => false, 'output' => 'No migration step ran.'];
                    $run = [
                        'command' => $command, 'display' => count($results) . ' migration step(s) executed',
                        'exitCode' => (int) $last['exitCode'], 'timedOut' => !empty($last['timedOut']),
                        'output' => implode("\n\n", array_map(static fn(array $item): string => '── ' . $item['label'] . ' (' . $item['display'] . ")\n" . ($item['output'] !== '' ? $item['output'] : '(no output)'), $results)),
                        'startedAt' => $startedAt, 'finishedAt' => gmdate(DATE_ATOM), 'steps' => $results,
                    ];
                    respond(['ok' => true, 'data' => ['run' => $run] + actionsSection($site, $user)]);
                }
                $state = operationsState($site, $user);
                $plan = null;
                if ($action === 'run') {
                    $command = (string) ($operation['command'] ?? '');
                    $steps = [resolveOperationStep($state, $command, $operation)];
                    if (!empty($state['expectedPort']) && in_array($command, ['compose-up', 'compose-deploy', 'compose-restart'], true)) {
                        $steps[] = resolveOperationStep($state, 'compose-port-verify', []);
                    } elseif (!empty($state['expectedPort']) && in_array($command, ['pm2-start', 'pm2-restart', 'pm2-restart-one'], true)) {
                        $steps[] = resolveOperationStep($state, 'runtime-port-verify', []);
                    }
                } else {
                    $plan = (string) ($operation['plan'] ?? '');
                    $steps = resolveDeploymentPlan($site, $state, $plan);
                }
                // Ordinary Compose now runs through the same unprivileged site
                // user boundary as SSH and Terminal. Only explicit host fixes
                // and rootful-to-rootless migration remain Super Admin-only.
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
                $results = executeOperationSteps($site, $steps);
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
                if ($action === 'deploy') $run['plan'] = $plan;
                if ($action === 'deploy' || count($results) > 1) $run['steps'] = $results;
                respond(['ok' => true, 'data' => ['run' => $run] + actionsSection($site, $user)]);
            } elseif ($section === 'env' && in_array($action, ['save', 'upsert'], true)) {
                $file = $action === 'upsert' ? '.env' : (string) ($operation['file'] ?? '.env');
                if (!in_array($file, PANELAVO_ENV_FILES, true)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $entries = validateEnvEntries($operation['entries'] ?? null);
                $root = siteRootPath($site);
                if (!is_dir($root)) {
                    if (!mkdir($root, 0755, true)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    chown($root, $site->getUser());
                    chgrp($root, $site->getUser());
                }
                $path = $root . '/' . $file;
                if (is_link($path) || (file_exists($path) && !is_file($path))) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $existing = is_file($path) && filesize($path) <= 262144 ? (string) @file_get_contents($path) : '';
                if ($action === 'upsert') $entries = array_replace(parseEnvContent($existing), $entries);
                if (@file_put_contents($path, renderEnvFile($existing, $entries)) === false) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                @chmod($path, 0640);
                chown($path, $site->getUser());
                chgrp($path, $site->getUser());
                // Only the primary .env mirrors into the site user's login
                // environment; secondary dotenv files stay file-only.
                if ($file === '.env' && ($operation['syncProfile'] ?? true)) writeSiteProfileEnv($site, $entries);
                respond(['ok' => true, 'data' => envSection($site)]);
            } elseif ($section === 'terminal' && $action === 'exec') {
                $result = runTerminalCommand($site, (string) ($operation['command'] ?? ''), isset($operation['cwd']) ? (string) $operation['cwd'] : null);
                respond(['ok' => true, 'data' => $result]);
            } elseif ($section === 'backups') {
                // File archiving and database export/import legitimately run for
                // minutes, so backups take the same per-site lock as Operations
                // to keep two heavy jobs from overlapping on one site. respond()
                // exits, so the advisory lock is released when the bridge process
                // ends — a crashed run can never wedge the site.
                $lock = @fopen('/var/lock/panelavo-operations-' . $site->getUser() . '.lock', 'c');
                if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) respond(['ok' => false, 'code' => 'OPERATION_BUSY']);
                if ($action === 'create') respond(['ok' => true, 'data' => createBackup($site, $operation)]);
                if ($action === 'delete') { deleteTree(safeBackupDir($site, (string) ($operation['id'] ?? ''))); respond(['ok' => true, 'data' => backupsSection($site)]); }
                if ($action === 'restore') { restoreBackup($site, $operation); respond(['ok' => true, 'data' => backupsSection($site)]); }
                respond(['ok' => false, 'code' => 'INVALID_ACTION']);
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
                    if (!preg_match('/^.+\.(zip|7z|rar|tar\.gz|tgz)$/i', $archiveName) || basename($archiveName) !== $archiveName) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    $destination = safeFileManagerPath($base, ($relative ? $relative . '/' : '') . $archiveName, false);
                    if (file_exists($destination)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    
                    $ext = preg_match('/\.(tar\.gz|tgz)$/i', $archiveName) ? 'tar.gz' : strtolower(pathinfo($archiveName, PATHINFO_EXTENSION));
                    $command = [];
                    if ($ext === 'zip') {
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/zip', '-r', '-q', $destination, $name];
                    } elseif ($ext === '7z') {
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/7z', 'a', $destination, $name];
                    } elseif ($ext === 'rar') {
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/rar', 'a', $destination, $name];
                    } elseif ($ext === 'tar.gz') {
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/tar', 'czf', $destination, '--', $name];
                    }
                    $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, dirname($path), ['HOME' => '/home/' . $site->getUser(), 'PATH' => '/usr/local/bin:/usr/bin:/bin']);
                    if (!is_resource($process)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    fclose($pipes[0]); stream_get_contents($pipes[1]); fclose($pipes[1]); stream_get_contents($pipes[2]); fclose($pipes[2]);
                    if (proc_close($process) !== 0) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);

                } elseif ($action === 'extract' && is_file($path)) {
                    $ext = preg_match('/\.(tar\.gz|tgz)$/i', $name) ? 'tar.gz' : strtolower(pathinfo($name, PATHINFO_EXTENSION));
                    if (!preg_match('/^(zip|7z|rar|tar\.gz)$/i', $ext)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    
                    // The destination folder is created (site-user-owned) when
                    // it does not exist yet.
                    $extractTo = trim((string) ($operation['extractTo'] ?? $relative));
                    $targetDirectory = ensureFileManagerDirectory($site, $base, $extractTo);

                    $command = [];
                    if ($ext === 'zip') {
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/unzip', '-q', '-o', $path, '-d', $targetDirectory];
                    } elseif ($ext === '7z') {
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/7z', 'x', '-y', '-o' . $targetDirectory, $path];
                    } elseif ($ext === 'rar') {
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/unrar', 'x', '-y', $path, $targetDirectory . '/'];
                    } elseif ($ext === 'tar.gz') {
                        // Inspect tar paths and entry types before extraction.
                        // Absolute/parent paths and links are rejected so an
                        // uploaded archive cannot escape the selected folder.
                        $names = runSiteCommand($site, ['/usr/bin/tar', 'tzf', $path], 300);
                        $listing = runSiteCommand($site, ['/usr/bin/tar', 'tvzf', $path], 300);
                        if ($names['code'] !== 0 || $listing['code'] !== 0) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                        foreach (preg_split('/\R/', trim($names['stdout'])) ?: [] as $entry) {
                            if ($entry === '') continue;
                            $normalized = str_replace('\\', '/', $entry);
                            if (str_starts_with($normalized, '/') || str_contains($normalized, "\0")) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                            foreach (explode('/', trim($normalized, '/')) as $part) {
                                if ($part === '..') respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                            }
                        }
                        foreach (preg_split('/\R/', trim($listing['stdout'])) ?: [] as $entry) {
                            if ($entry !== '' && !in_array($entry[0], ['-', 'd'], true)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                        }
                        $command = ['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/tar', 'xzf', $path, '--no-same-owner', '--no-same-permissions', '-C', $targetDirectory];
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

        case 'site-release':
            $site = requireSiteWriter(
                $manager,
                $user,
                brokerDomainValue($input['domain'] ?? null),
                !empty($input['panelAdmin']),
            );
            $operation = $input['operation'] ?? null;
            if (!is_array($operation) || count($operation) > 12) invalidBrokerRequest();
            respond(['ok' => true, 'data' => manageArtifactRelease($site, $user, $operation)]);

        case 'site-recovery':
            $site = requireSiteWriter(
                $manager,
                $user,
                brokerDomainValue($input['domain'] ?? null),
                !empty($input['panelAdmin']),
            );
            $operation = $input['operation'] ?? null;
            if (!is_array($operation) || count($operation) !== 1) invalidBrokerRequest();
            respond(['ok' => true, 'data' => manageSiteRecovery($site, $user, $operation)]);

        case 'site-datastore':
            $site = requireSiteWriter(
                $manager,
                $user,
                brokerDomainValue($input['domain'] ?? null),
                !empty($input['panelAdmin']),
            );
            $operation = $input['operation'] ?? null;
            if (!is_array($operation) || count($operation) > 10) invalidBrokerRequest();
            respond(['ok' => true, 'data' => manageSiteDatastore($site, $user, $operation)]);

        case 'site-endpoint':
            $site = requireSiteWriter(
                $manager,
                $user,
                brokerDomainValue($input['domain'] ?? null),
                !empty($input['panelAdmin']),
            );
            $operation = $input['operation'] ?? null;
            if (!is_array($operation) || count($operation) > 3) invalidBrokerRequest();
            respond(['ok' => true, 'data' => manageSiteEndpoint($manager, $site, $operation)]);

        case 'update-site':
            $site = authorizedSite($manager, $user, (string) ($input['domain'] ?? ''));
            if (!in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true) && empty($input['panelAdmin'])) {
                respond(['ok' => false, 'code' => 'FORBIDDEN']);
            }
            [$model, $updater] = siteModel($site);
            $settings = $input['settings'] ?? [];
            if (!is_array($settings)) invalidBrokerRequest();
            $requestedPort = requestedSitePort($settings);
            $verifiedEndpointPort = false;
            if ($requestedPort !== null && isset($input['endpointParentDomain'])) {
                $parent = authorizedSite(
                    $manager,
                    $user,
                    brokerDomainValue($input['endpointParentDomain']),
                );
                $endpointCheck = manageSiteEndpoint($manager, $parent, [
                    'action' => 'verify',
                    'port' => $requestedPort,
                    'endpointDomain' => strtolower((string) $site->getDomainName()),
                ]);
                $probe = $endpointCheck['probe'] ?? null;
                $verifiedEndpointPort = is_array($probe)
                    && !empty($probe['owned'])
                    && !empty($probe['loopback'])
                    && !empty($probe['reachable']);
            }
            if ($requestedPort !== null
                && $requestedPort !== expectedSitePort($site)
                && in_array($requestedPort, hostReservedPorts($manager), true)
                && !$verifiedEndpointPort) {
                respond([
                    'ok' => false,
                    'code' => 'INVALID_REQUEST',
                    'message' => 'Application port ' . $requestedPort . ' is already reserved or listening on this server.',
                ]);
            }
            $runtimeChanged = false;
            if (array_key_exists('applicationRootDirectory', $input) && !is_dir(siteRootPath($site))) {
                respond(['ok' => false, 'code' => 'INVALID_REQUEST', 'message' => 'The root directory does not exist.']);
            }
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
                $port = brokerPortValue($settings['appPort']);
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
