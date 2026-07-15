<?php

// Panelavo -> phpMyAdmin single sign-on consumer. Installed by setup.sh as
// signon.php in the database manager's webroot (/home/<user>/htdocs/<domain>).
//
// The panel's root broker writes the database user's credentials into an
// expiring token file under /home/<user>/.pma-signon/ and hands the browser
// only the random token. This script consumes the token exactly once (the
// file is deleted before its contents are used), loads the credentials into
// phpMyAdmin's signon session, and redirects into server 2 (the signon-auth
// server defined in config.inc.php). Credentials never appear in any URL.

declare(strict_types=1);

const PANELAVO_SIGNON_EXPIRED =
    'This sign-in link has expired. Return to the panel and click Manage again.';

$token = (string) ($_GET['token'] ?? '');
if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
    http_response_code(400);
    exit(PANELAVO_SIGNON_EXPIRED);
}

// Webroot is /home/<user>/htdocs/<domain>, so the site home is two levels up.
$file = dirname(__DIR__, 2) . '/.pma-signon/' . $token . '.json';
$raw = is_file($file) && !is_link($file) ? file_get_contents($file) : false;
if (is_file($file)) {
    unlink($file);
}
$data = is_string($raw) ? json_decode($raw, true) : null;
if (!is_array($data) || (int) ($data['expires'] ?? 0) < time()) {
    http_response_code(410);
    exit(PANELAVO_SIGNON_EXPIRED);
}

session_name('PanelavoSignon');
session_start();
session_regenerate_id(true);
$_SESSION['PMA_single_signon_user'] = (string) ($data['user'] ?? '');
$_SESSION['PMA_single_signon_password'] = (string) ($data['password'] ?? '');
$_SESSION['PMA_single_signon_host'] = '127.0.0.1';
session_write_close();

$db = (string) ($data['db'] ?? '');
$suffix = preg_match('/^[A-Za-z0-9_-]{1,64}$/', $db) ? '&db=' . rawurlencode($db) : '';
header('Location: index.php?server=2' . $suffix);
