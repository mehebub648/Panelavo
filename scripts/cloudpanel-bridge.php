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
const PANELAVO_BROKER_PROTOCOL_VERSION = 5;
const PANELAVO_BROKER_MAX_INPUT_BYTES = 100663296;
const PANELAVO_ROOTLESS_MIGRATION_ROOT = '/var/lib/panelavo/rootless-migrations';
const PANELAVO_ROOTLESS_MIGRATION_TTL = 86400;

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
function pruneBackups(Site $site): void
{
    $base = backupsBase($site);
    $dirs = array_values(array_filter(
        glob($base . '/*', GLOB_ONLYDIR) ?: [],
        static fn($dir) => is_file($dir . '/manifest.json'),
    ));
    usort($dirs, static fn($a, $b) => strcmp($b, $a));
    foreach (array_slice($dirs, PANELAVO_BACKUP_RETENTION) as $old) deleteTree($old);
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
    pruneBackups($site);
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

function sitePortCapability(Site $site, array $listeners): array
{
    $expected = expectedSitePort($site);
    $sitePorts = array_values(array_unique(array_map(
        static fn(array $item): int => (int) $item['port'],
        array_filter($listeners, static fn(array $item): bool => !empty($item['siteOwned'])),
    )));
    sort($sitePorts);
    $listening = $expected !== null && count(array_filter($listeners, static fn(array $item): bool => (int) $item['port'] === $expected)) > 0;
    if ($expected === null) $detail = 'This CloudPanel site is served directly and has no application upstream port.';
    elseif ($listening) $detail = "A process is listening on the configured upstream port $expected.";
    elseif ($sitePorts) $detail = 'CloudPanel expects port ' . $expected . ', but site-owned processes currently listen on ' . implode(', ', $sitePorts) . '.';
    else $detail = "CloudPanel expects port $expected, but no process is listening there yet.";
    return ['expected' => $expected, 'listening' => $listening, 'detected' => $sitePorts, 'detail' => $detail];
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
    return [
        'type' => $site->getType(),
        'path' => $root,
        'framework' => detectFramework($root, $package),
        'processName' => preg_replace('/[^a-zA-Z0-9._-]/', '-', $site->getDomainName()),
        'reverseProxyUrl' => $site->getReverseProxyUrl(),
        'expectedPort' => $port['expected'],
        'port' => $port,
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
        'compose' => $composeFile !== null ? composeCapability($site, $root, $composeFile) : null,
        'permissions' => [
            'manage' => in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true),
            'docker' => $user->getRole() === User::ROLE_ADMIN,
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
            );
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

// Site-scoped repair for the "publishes a port without binding it to
// 127.0.0.1" host-safety blocker. The edited file is validated with
// `docker compose config` and re-scanned against the full safety policy; the
// change is committed only when the result is fully safe, so the file is never
// left broken or still-unsafe. A one-time backup is written next to it.
function bindComposePortsToLoopback(Site $site, array &$results): void
{
    $fix = 'bind-ports-loopback';
    $root = siteRootPath($site);
    $compose = findComposeFile($root);
    if (!$compose) { syntheticFixStep($results, $fix, 'Locate Compose file', 'find compose file', false, 'No Compose file was found in the site root or a subfolder.'); return; }
    $path = $root . '/' . $compose;
    $original = (string) @file_get_contents($path);
    if ($original === '') { syntheticFixStep($results, $fix, 'Read Compose file', 'read ' . $compose, false, 'The Compose file could not be read.'); return; }

    $rewritten = rewriteComposePorts($original);
    if ($rewritten === $original) {
        syntheticFixStep($results, $fix, 'Rewrite published ports', 'edit ' . $compose, false,
            'Panelavo could not automatically rewrite the published ports — they may use the long mapping or flow syntax. Bind each published port manually: short syntax "127.0.0.1:8080:80", or long syntax with "host_ip: 127.0.0.1".');
        return;
    }

    $tmpName = '.panelavo-compose-check.yaml';
    $tmpPath = $root . '/' . $tmpName;
    if (@file_put_contents($tmpPath, $rewritten) === false) {
        syntheticFixStep($results, $fix, 'Stage rewritten Compose', 'write ' . $tmpName, false, 'A temporary Compose file could not be written to the site root.');
        return;
    }
    @chown($tmpPath, $site->getUser());
    @chgrp($tmpPath, $site->getUser());
    try {
        $config = runSiteCommand($site, ['docker', 'compose', '-f', $tmpName, '-p', composeProjectName($site), 'config', '--format', 'json'], 60, true);
        if ($config['code'] !== 0) {
            syntheticFixStep($results, $fix, 'Validate rewritten Compose', 'docker compose config', false,
                (trim($config['stderr'] !== '' ? $config['stderr'] : $config['stdout']) ?: 'The rewritten Compose file failed validation.') . "\nNo changes were made.");
            return;
        }
        $parsed = json_decode($config['stdout'], true);
        $scan = is_array($parsed) ? composeSafetyScan($parsed, $root) : ['safe' => false, 'detail' => 'The rewritten configuration could not be parsed.'];
        if (($scan['safe'] ?? false) !== true) {
            syntheticFixStep($results, $fix, 'Verify host-safety policy', 're-scan resolved config', false,
                'The automatic rewrite did not fully satisfy the host-safety policy' . (!empty($scan['detail']) ? ': ' . $scan['detail'] : '') . ". No changes were made; please adjust the Compose file manually.");
            return;
        }
        @copy($path, $path . '.panelavo.bak');
        $ok = @file_put_contents($path, $rewritten) !== false;
        if ($ok) { @chown($path, $site->getUser()); @chgrp($path, $site->getUser()); }
        syntheticFixStep($results, $fix, 'Bind published ports to 127.0.0.1', 'edit ' . $compose, $ok,
            $ok ? "Updated $compose (backup saved as $compose.panelavo.bak).\n" . composeDiffSummary($original, $rewritten)
                : 'The validated Compose file could not be written back.');
    } finally {
        @unlink($tmpPath);
    }
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
    $assert((int) ($config['services']['frontend']['ports'][0]['published'] ?? 0) === 3000, 'source config must not be mutated');
    $assert(array_key_exists('ipam', $config['networks']['default']), 'source network config must not be mutated');

    $ambiguous = composePortRouting(24001, ['services' => [
        'alpha' => ['ports' => [['target' => 8000, 'published' => '8000']]],
        'beta' => ['ports' => [['target' => 9000, 'published' => '9000']]],
    ]]);
    $assert($ambiguous['entryService'] === null, 'ambiguous services must not be guessed');
    $assert(str_contains($ambiguous['portDetail'], 'io.panelavo.entrypoint=true'), 'ambiguity should include the repair instruction');
    echo "Compose port routing self-test passed.\n";
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

if (($argv[1] ?? '') === '--self-test-ports') runComposePortSelfTest();
if (($argv[1] ?? '') === '--self-test-env') runEnvSelfTest();
if (($argv[1] ?? '') === '--self-test-rootless') runRootlessSelfTest();

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
        respond(['ok' => true, 'data' => [
            'broker' => 'panelavo',
            'protocolVersion' => PANELAVO_BROKER_PROTOCOL_VERSION,
            'privileged' => true,
            'cloudPanelAvailable' => is_readable(CLOUDPANEL_ROOT . '/vendor/autoload.php')
                && is_executable('/usr/bin/clpctl'),
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
            respond(['ok' => true, 'data' => ['templates' => array_values(array_unique($templates))]]);

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
            finishClpctl(runClpctl($args));

        case 'clpctl-site-delete':
            $domain = brokerDomainValue($input['domain'] ?? null);
            $site = requireSiteWriter($manager, $user, $domain, ($input['panelAdmin'] ?? false) === true);
            cleanupRootlessDockerBeforeSiteDelete($site);
            finishClpctl(runClpctl(['site:delete', '--domainName=' . $domain, '--force']));

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
            finishClpctl(runClpctl(['db:delete', '--databaseName=' . $databaseName, '--force']));

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
            $databaseUser = $database->getUsers()->toArray()[0] ?? null;
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
                elseif ($action === 'pull') {
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
                respond(['ok' => true, 'data' => gitSection($site, null, $notice ?? null)]);
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
                    // Host-software repairs are a Super Admin boundary and are
                    // serialized host-wide because they change shared APT and
                    // systemd state.
                    if (($input['panelAdmin'] ?? false) !== true) respond(['ok' => false, 'code' => 'FORBIDDEN']);
                    $lockPath = '/var/lock/panelavo-host-fix.lock';
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
                    if (($input['panelAdmin'] ?? false) !== true) respond(['ok' => false, 'code' => 'FORBIDDEN']);
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
                        $result = runSiteCommand(
                            $site,
                            $args,
                            $stepDefinition['timeout'],
                            !empty($stepDefinition['asRoot']),
                            (array) ($stepDefinition['env'] ?? []),
                        );
                    } finally {
                        if ($temporaryCompose !== null) @unlink($temporaryCompose);
                    }
                    $results[] = [
                        'command' => $stepDefinition['command'],
                        'label' => $stepDefinition['label'],
                        'display' => implode(' ', $displayArgs),
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
