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
    $model->setType($site->getType());
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
                ],
                'file-manager' => ['path' => '/home/' . $site->getUser() . '/htdocs/' . $site->getRootDirectory(), 'items' => array_values(array_filter(scandir('/home/' . $site->getUser() . '/htdocs/' . $site->getRootDirectory()) ?: [], fn($name) => !in_array($name, ['.', '..'], true)))],
                'cron-jobs' => ['items' => array_map(fn($item) => ['id' => (string) $item->getId(), 'schedule' => $item->getSchedule(), 'command' => $item->getCommand(), 'expression' => $item->getCrontabExpression()], $site->getCronJobs()->toArray())],
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
            if (!in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true)) respond(['ok' => false, 'code' => 'FORBIDDEN']);
            $section = (string) ($input['section'] ?? '');
            $operation = $input['operation'] ?? [];
            $action = (string) ($operation['action'] ?? '');
            [$model, $updater] = siteModel($site);

            if ($section === 'vhost' && $action === 'save') {
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
                $entity = new CronJob(); $entity->setSite($site);
                $entity->setMinute($parts[0]); $entity->setHour($parts[1]); $entity->setDay($parts[2]); $entity->setMonth($parts[3]); $entity->setWeekday($parts[4]);
                $entity->setCommand((string) $operation['command']); $site->addCronJob($entity); $manager->persist($entity); $updater->updateUserCrontab();
            } elseif ($section === 'cron-jobs' && $action === 'delete') {
                $entity = $manager->getRepository(CronJob::class)->find((int) $operation['id']);
                if ($entity && $entity->getSite()->getId() === $site->getId()) { $site->removeCronJob($entity); $manager->remove($entity); $updater->updateUserCrontab(); }
            } elseif ($section === 'file-manager') {
                $base = realpath('/home/' . $site->getUser() . '/htdocs/' . $site->getRootDirectory());
                $name = basename((string) ($operation['name'] ?? ''));
                if (!$base || !$name || $name !== (string) ($operation['name'] ?? '')) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                $path = $base . '/' . $name;
                if ($action === 'new-file') file_put_contents($path, (string) ($operation['content'] ?? ''));
                elseif ($action === 'new-folder') mkdir($path, 0770);
                elseif ($action === 'save-file' && is_file($path)) file_put_contents($path, (string) ($operation['content'] ?? ''));
                elseif ($action === 'delete' && is_file($path)) unlink($path);
                elseif ($action === 'delete' && is_dir($path)) rmdir($path);
                else respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                if (file_exists($path)) { chown($path, $site->getUser()); chgrp($path, $site->getUser()); }
            } elseif ($section === 'logs' && $action === 'clear') {
                $base = realpath('/home/' . $site->getUser() . '/logs');
                $name = ltrim((string) ($operation['name'] ?? ''), '/');
                $path = $base . '/' . $name;
                $real = realpath($path);
                if (!$base || !$name || !$real || !is_file($real) || !str_starts_with($real, $base . '/')) respond(['ok' => false, 'code' => 'INVALID_REQUEST']);
                file_put_contents($path, '');
            } else respond(['ok' => false, 'code' => 'INVALID_ACTION']);
            $manager->flush();
            respond(['ok' => true]);

        case 'update-site':
            $site = authorizedSite($manager, $user, (string) ($input['domain'] ?? ''));
            if (!in_array($user->getRole(), [User::ROLE_ADMIN, User::ROLE_SITE_MANAGER], true)) {
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
    respond(['ok' => false, 'code' => 'BRIDGE_FAILED'], 1);
}
