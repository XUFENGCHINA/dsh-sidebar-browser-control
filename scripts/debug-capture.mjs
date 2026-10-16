/**
 * Debug the Host half's window capture outside DSH, using its real code.
 *
 * The capture path cannot run in the offline bridge test (it needs a real
 * window), so this is the tool to reach for when `browser_page screenshot`
 * misbehaves: it prints what the capture script sees, then captures.
 *
 * Run: node scripts/debug-capture.mjs [cropX cropY cropW cropH]
 *      (0 0 0 0 captures the whole window; a minimized window is restored,
 *       which makes DSH visible again)
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureScript, runPowerShell, geometryToCrop, captureWindow } from '../index.js';

const [x = '0', y = '0', w = '0', h = '0'] = process.argv.slice(2);
const crop = { x: Number(x), y: Number(y), width: Number(w), height: Number(h) };

console.log('--- crop ---', JSON.stringify(crop));
console.log('--- geometryToCrop sample ---', JSON.stringify(geometryToCrop({
  rect: { left: 700, top: 30, width: 560, height: 760 },
  devicePixelRatio: 1,
  outer: { width: 1296, height: 828, innerWidth: 1280, innerHeight: 820 }
})));

const script = captureScript(join(tmpdir(), 'dsh-debug-shot.png'), crop);
console.log('--- script (first 3 lines) ---');
console.log(script.split('\n').slice(0, 3).join('\n'));

/* Ground truth: what does the capture script actually see? */
const enumScript = [
  '$ProgressPreference = "SilentlyContinue"',
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class DshEnum {',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  '}',
  '"@',
  "foreach ($c in (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {",
  '  $h = $c.MainWindowHandle',
  '  if ($h -eq 0) { continue }',
  '  $r = New-Object DshEnum+RECT',
  '  [void][DshEnum]::GetWindowRect($h, [ref]$r)',
  '  Write-Output ("pid=" + $c.Id + " hwnd=" + $h + " visible=" + [DshEnum]::IsWindowVisible($h) + " iconic=" + [DshEnum]::IsIconic($h) + " rect=" + $r.Left + "," + $r.Top + "," + $r.Right + "," + $r.Bottom + " title=[" + $c.MainWindowTitle + "]")',
  '}',
  'Write-Output "--- now foreground/visible windows ---"',
  "Add-Type -AssemblyName System.Windows.Forms",
  'Write-Output ("foreground=" + [System.Windows.Forms.Form]::ActiveForm)'
].join('\n');
try {
  const dump = await runPowerShell(enumScript, 30_000);
  console.log('--- environment ---');
  console.log(dump);
} catch (error) {
  console.log('--- enumeration failed ---', String(error.message).slice(0, 400));
}

console.log('--- line endings in script ---', / \r\n/u.test(script) ? 'CRLF' : 'LF');

try {
  const out = await runPowerShell(script, 30_000);
  console.log('--- runPowerShell OK ---', JSON.stringify(out));
} catch (error) {
  console.log('--- runPowerShell FAILED ---');
  console.log(String(error.message).slice(0, 1000));
}

try {
  const bytes = await captureWindow(crop, 30_000, true);
  const dump = join(tmpdir(), 'dsh-debug-shot-check.png');
  writeFileSync(dump, bytes);
  console.log('--- captureWindow OK ---', bytes.length, 'bytes ->', dump);
} catch (error) {
  console.log('--- captureWindow FAILED ---');
  console.log(String(error.message).slice(0, 1000));
}
