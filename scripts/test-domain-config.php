<?php
// Exercise only the pure template transformer; never boot the root broker.
$source = file_get_contents(__DIR__ . '/cloudpanel-bridge.php');
$start = strpos($source, 'function applyDomainConfig(');
$end = strpos($source, '// Latest nvm-managed', $start);
eval(substr($source, $start, $end - $start));
function check(bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
}
$template = "server {\n  server_name system.example.com;\n}\n";
$aliases = ['example.com', 'www.example.com'];
$enabled = applyDomainConfig($template, $aliases, 'none', 'system.example.com', '', ['example.com']);
check(str_contains($enabled, 'if ($host = "example.com")'), 'Only the bare host must redirect');
check(str_contains($enabled, 'return 301 https://www.example.com$request_uri;'), 'Preserve path and query');
check(str_contains($enabled, 'acme-challenge/'), 'Exempt ACME requests');
check(!str_contains($enabled, 'if ($host = "www.example.com")'), 'Do not redirect www to itself');
check(applyDomainConfig($enabled, $aliases, 'none', 'system.example.com', '', ['example.com']) === $enabled, 'Repeated application must be idempotent');
$disabled = applyDomainConfig($enabled, $aliases, 'none', 'system.example.com', '');
check(!str_contains($disabled, 'panel_www_redirect'), 'Disabling must remove redirect rules');
check(str_contains($disabled, 'example.com www.example.com;'), 'Both aliases must remain hosted');
$blocked = applyDomainConfig($enabled, $aliases, 'error', 'system.example.com', '', ['example.com']);
check(str_contains($blocked, 'return 403;') && str_contains($blocked, 'return 301'), 'System-domain policy must coexist');
echo "Domain configuration tests passed.\n";
