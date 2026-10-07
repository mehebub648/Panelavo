<?php
declare(strict_types=1);
$source = file_get_contents(__DIR__ . '/cloudpanel-bridge.php');
$start = strpos($source, 'function inspectApplicationStructure(');
$end = strpos($source, 'function detectFramework(', $start);
eval(substr($source, $start, $end - $start));
function checkStructure(bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
}
$root = sys_get_temp_dir() . '/panelavo-structure-' . bin2hex(random_bytes(8));
mkdir($root, 0700);
$make = function (string $path, string $marker) use ($root): void {
    if (!is_dir($root . '/' . $path)) mkdir($root . '/' . $path, 0700, true);
    file_put_contents($root . '/' . $path . '/' . $marker, '{}');
};
$cleanup = function (string $path) use (&$cleanup, $root): void {
    if (!str_starts_with($path, $root . '/') && $path !== $root) throw new RuntimeException('Outside fixture');
    if (is_link($path) || is_file($path)) { unlink($path); return; }
    foreach (scandir($path) as $name) if ($name !== '.' && $name !== '..') $cleanup($path . '/' . $name);
    rmdir($path);
};
try {
    file_put_contents($root . '/package.json', '{}');
    $make('apps/web', 'package.json');
    $make('backend', 'requirements.txt');
    $make('public', 'index.html');
    $make('node_modules/dependency', 'package.json');
    $make('.data/private', 'package.json');
    $make('tests/fixture', 'composer.json');
    $make('deep/one/two', 'package.json');
    symlink($root . '/apps', $root . '/linked-apps');
    symlink($root . '/package.json', $root . '/composer.json');
    $result = inspectApplicationStructure($root);
    checkStructure($result['manifests'] === ['package.json'], 'Never follow manifest symlinks');
    $paths = array_column($result['candidates'], 'path');
    checkStructure(in_array('apps/web', $paths, true), 'Find a nested workspace application');
    checkStructure(in_array('backend', $paths, true), 'Find a Python backend');
    checkStructure(in_array('public', $paths, true), 'Find a static serving directory');
    checkStructure(count($paths) === 3, 'Skip dependencies, private state, fixtures, symlinks, and deep descendants');
    checkStructure($result['truncated'] === false, 'Complete small scans');
    for ($index = 0; $index < 80; $index++) $make('many-' . $index, 'package.json');
    $limited = inspectApplicationStructure($root);
    checkStructure($limited['scannedDirectories'] <= 40, 'Bound directory inspection');
    checkStructure($limited['truncated'] === true, 'Disclose incomplete inspection');
    echo "Operations structure tests passed.\n";
} finally { $cleanup($root); }
