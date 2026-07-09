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
        'role' => $role,
        'canCreateSites' => in_array($role, ['admin', 'site-manager'], true),
        'email' => $user->getEmail(),
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

function addToZip(ZipArchive $zip, string $path, string $archivePath): void
{
    if (is_link($path) || is_file($path)) { $zip->addFile($path, $archivePath); return; }
    $zip->addEmptyDir($archivePath);
    foreach (scandir($path) ?: [] as $name) {
        if ($name !== '.' && $name !== '..') addToZip($zip, $path . '/' . $name, $archivePath . '/' . $name);
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

function siteRootPath(Site $site): string
{
    return rtrim('/home/' . $site->getUser() . '/htdocs/' . trim($site->getRootDirectory(), '/'), '/');
}

// Runs an allow-listed maintenance command inside the site root as the site
// user, through env(1) so PATH/HOME survive sudo's environment reset.
function runSiteCommand(Site $site, array $args, int $timeout = 300, bool $asRoot = false): array
{
    $cwd = realpath(siteRootPath($site));
    if (!$cwd) respond(['ok' => false, 'code' => 'SITE_NOT_FOUND']);
    $home = $asRoot ? '/root' : '/home/' . $site->getUser();
    $env = ['/usr/bin/env', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=' . $home];
    $command = array_merge(
        ['/usr/bin/timeout', '--signal=KILL', (string) $timeout],
        $asRoot ? $env : array_merge(['/usr/bin/sudo', '-n', '-u', $site->getUser(), '--'], $env),
        $args,
    );
    $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd);
    if (!is_resource($process)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]); fclose($pipes[1]);
    $stderr = stream_get_contents($pipes[2]); fclose($pipes[2]);
    $code = proc_close($process);
    return [
        'code' => $code,
        'timedOut' => $code === 137,
        'stdout' => substr($stdout ?: '', 0, 400000),
        'stderr' => substr($stderr ?: '', 0, 100000),
    ];
}

function actionsSection(Site $site): array
{
    $root = siteRootPath($site);
    $scripts = [];
    if (is_file($root . '/package.json')) {
        $package = json_decode((string) file_get_contents($root . '/package.json'), true);
        foreach ((is_array($package) ? ($package['scripts'] ?? []) : []) as $name => $command) {
            if (is_string($command)) $scripts[] = ['name' => (string) $name, 'command' => $command];
        }
    }
    $processes = [];
    if (is_executable('/usr/local/bin/pm2') && is_dir($root)) {
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
    return [
        'type' => $site->getType(),
        'path' => $root,
        'processName' => preg_replace('/[^a-zA-Z0-9._-]/', '-', $site->getDomainName()),
        'hasPackageJson' => is_file($root . '/package.json'),
        'scripts' => $scripts,
        'hasComposer' => is_file($root . '/composer.json'),
        'hasArtisan' => is_file($root . '/artisan'),
        'hasRequirements' => is_file($root . '/requirements.txt'),
        'hasCompose' => is_file($root . '/docker-compose.yml') || is_file($root . '/docker-compose.yaml')
            || is_file($root . '/compose.yml') || is_file($root . '/compose.yaml'),
        'hasEcosystem' => is_file($root . '/ecosystem.config.js') || is_file($root . '/ecosystem.config.cjs'),
        'pm2Available' => is_executable('/usr/local/bin/pm2'),
        'dockerAvailable' => is_executable('/usr/bin/docker') || is_executable('/usr/local/bin/docker'),
        'pm2' => $processes,
    ];
}

function readMeminfo(): array
{
    $values = [];
    foreach (preg_split('/\R/', (string) @file_get_contents('/proc/meminfo')) ?: [] as $line) {
        if (preg_match('/^(\w+):\s+(\d+)\s*kB/', $line, $m)) $values[$m[1]] = (int) $m[2] * 1024;
    }
    return $values;
}

function cpuUsagePercent(): float
{
    $sample = function (): ?array {
        $line = strtok((string) @file_get_contents('/proc/stat'), "\n");
        if (!$line || !preg_match('/^cpu\s+(.+)$/', $line, $m)) return null;
        $parts = array_map('intval', preg_split('/\s+/', trim($m[1])));
        $idle = ($parts[3] ?? 0) + ($parts[4] ?? 0);
        return [array_sum($parts), $idle];
    };
    $first = $sample();
    usleep(250000);
    $second = $sample();
    if (!$first || !$second || $second[0] <= $first[0]) return 0.0;
    $total = $second[0] - $first[0];
    $idle = $second[1] - $first[1];
    return round(max(0, min(100, (1 - $idle / max(1, $total)) * 100)), 1);
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

    // Aggregate live process usage by system user.
    $byUser = [];
    foreach (preg_split('/\R/', (string) shell_exec('ps -eo user:32,pcpu,pmem,rss --no-headers 2>/dev/null')) ?: [] as $line) {
        $parts = preg_split('/\s+/', trim($line));
        if (count($parts) < 4) continue;
        [$name, $cpu, $memPct, $rss] = $parts;
        $byUser[$name] ??= ['user' => $name, 'cpuPercent' => 0.0, 'memoryPercent' => 0.0, 'memoryBytes' => 0, 'processes' => 0];
        $byUser[$name]['cpuPercent'] += (float) $cpu;
        $byUser[$name]['memoryPercent'] += (float) $memPct;
        $byUser[$name]['memoryBytes'] += (int) $rss * 1024;
        $byUser[$name]['processes']++;
    }

    // Site users: attach their domains and home-directory disk usage. du is
    // expensive, so results are cached for 10 minutes.
    $domainsByUser = [];
    foreach ($manager->getRepository(Site::class)->findAll() as $site) {
        $domainsByUser[$site->getUser()][] = $site->getDomainName();
    }
    $cacheFile = '/tmp/.clp-pro-panel-du-cache.json';
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
            'usedPercent' => cpuUsagePercent(),
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
        $version = softwareVersion('env PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin ' . $command);
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
    $command = array_merge(['/usr/bin/sudo', '-u', $site->getUser(), '/usr/bin/git', '-c', 'safe.directory=' . $cwd], $args);
    $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd, ['HOME' => '/home/' . $site->getUser(), 'PATH' => '/usr/local/bin:/usr/bin:/bin']);
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
                'certificates' => ['items' => array_map(fn($cert) => [
                    'id' => (string) $cert->getId(),
                    'type' => $cert->getType(),
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
                'actions' => actionsSection($site),
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
                    if (!$root || count(array_diff(scandir($root) ?: [], ['.', '..'])) > 0) respond(['ok' => false, 'code' => 'DIRECTORY_NOT_EMPTY']);
                    runGit($site, array_values(array_filter(['clone', $ref ? '--branch' : null, $ref ?: null, $url, '.'])));
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
                if ($action !== 'run') respond(['ok' => false, 'code' => 'INVALID_ACTION']);
                $command = (string) ($operation['command'] ?? '');
                $script = (string) ($operation['script'] ?? '');
                if ($script !== '' && !preg_match('/^[A-Za-z0-9:._-]{1,64}$/', $script)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $root = siteRootPath($site);
                $name = preg_replace('/[^a-zA-Z0-9._-]/', '-', $site->getDomainName());
                $composeFile = null;
                foreach (['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'] as $candidate) {
                    if (is_file($root . '/' . $candidate)) { $composeFile = $candidate; break; }
                }
                $ecosystem = is_file($root . '/ecosystem.config.js') ? 'ecosystem.config.js'
                    : (is_file($root . '/ecosystem.config.cjs') ? 'ecosystem.config.cjs' : null);
                // Allow-listed commands only — nothing user-supplied is ever
                // passed to a shell. Docker runs as root, so those commands are
                // reserved for CloudPanel admins and site managers.
                $asRoot = false;
                $timeout = 300;
                switch ($command) {
                    case 'npm-install': $args = ['npm', 'install', '--no-audit', '--no-fund']; $timeout = 600; break;
                    case 'npm-ci': $args = ['npm', 'ci', '--no-audit', '--no-fund']; $timeout = 600; break;
                    case 'npm-run':
                        $package = is_file($root . '/package.json') ? json_decode((string) file_get_contents($root . '/package.json'), true) : null;
                        if ($script === '' || !is_array($package) || !isset($package['scripts'][$script])) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                        $args = ['npm', 'run', $script];
                        $timeout = 600;
                        break;
                    case 'pm2-start':
                        $args = $ecosystem ? ['pm2', 'startOrReload', $ecosystem] : ['pm2', 'start', 'npm', '--name', $name, '--', 'start'];
                        break;
                    case 'pm2-restart': $args = ['pm2', 'restart', 'all', '--update-env']; break;
                    case 'pm2-stop': $args = ['pm2', 'stop', 'all']; break;
                    case 'pm2-delete': $args = ['pm2', 'delete', 'all']; break;
                    case 'pm2-save': $args = ['pm2', 'save', '--force']; break;
                    case 'pm2-status': $args = ['pm2', 'status']; break;
                    case 'pm2-logs': $args = ['pm2', 'logs', '--nostream', '--lines', '200']; $timeout = 30; break;
                    case 'composer-install': $args = ['composer', 'install', '--no-interaction', '--no-progress']; $timeout = 600; break;
                    case 'composer-update': $args = ['composer', 'update', '--no-interaction', '--no-progress']; $timeout = 600; break;
                    case 'artisan-migrate': $args = ['php', 'artisan', 'migrate', '--force']; break;
                    case 'artisan-optimize': $args = ['php', 'artisan', 'optimize:clear']; break;
                    case 'artisan-storage-link': $args = ['php', 'artisan', 'storage:link']; break;
                    case 'pip-install': $args = ['python3', '-m', 'pip', 'install', '--user', '-r', 'requirements.txt']; $timeout = 600; break;
                    case 'compose-up': $asRoot = true; $args = ['docker', 'compose', 'up', '-d', '--remove-orphans']; $timeout = 600; break;
                    case 'compose-down': $asRoot = true; $args = ['docker', 'compose', 'down']; break;
                    case 'compose-restart': $asRoot = true; $args = ['docker', 'compose', 'restart']; break;
                    case 'compose-pull': $asRoot = true; $args = ['docker', 'compose', 'pull']; $timeout = 600; break;
                    case 'compose-ps': $asRoot = true; $args = ['docker', 'compose', 'ps']; $timeout = 30; break;
                    case 'compose-logs': $asRoot = true; $args = ['docker', 'compose', 'logs', '--tail', '200', '--no-color']; $timeout = 30; break;
                    default: respond(['ok' => false, 'code' => 'INVALID_ACTION']);
                }
                if ($asRoot) {
                    if (!in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true)) respond(['ok' => false, 'code' => 'FORBIDDEN']);
                    if (!$composeFile) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                }
                $result = runSiteCommand($site, $args, $timeout, $asRoot);
                respond(['ok' => true, 'data' => [
                    'run' => [
                        'command' => $command,
                        'display' => implode(' ', $args),
                        'exitCode' => $result['code'],
                        'timedOut' => $result['timedOut'],
                        'output' => trim($result['stdout'] . ($result['stderr'] !== '' ? "\n" . $result['stderr'] : '')),
                    ],
                ] + actionsSection($site)]);
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
                    $decoded = base64_decode((string) ($operation['content'] ?? ''), true);
                    if ($decoded === false) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
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
                    if (!str_ends_with(strtolower($archiveName), '.zip') || basename($archiveName) !== $archiveName) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    $destination = safeFileManagerPath($base, ($relative ? $relative . '/' : '') . $archiveName, false);
                    if (file_exists($destination)) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    $zip = new ZipArchive();
                    if ($zip->open($destination, ZipArchive::CREATE | ZipArchive::EXCL) !== true) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    addToZip($zip, $path, $name); $zip->close();
                } elseif ($action === 'extract' && is_file($path) && str_ends_with(strtolower($name), '.zip')) {
                    $zip = new ZipArchive();
                    if ($zip->open($path) !== true) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                    for ($index = 0; $index < $zip->numFiles; $index++) {
                        $entry = str_replace('\\', '/', (string) $zip->getNameIndex($index));
                        if ($entry === '' || str_starts_with($entry, '/') || in_array('..', explode('/', $entry), true)) { $zip->close(); respond(['ok' => false, 'code' => 'INVALID_REQUEST']); }
                    }
                    if (!$zip->extractTo($directory)) { $zip->close(); respond(['ok' => false, 'code' => 'INVALID_REQUEST']); }
                    $zip->close();
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
