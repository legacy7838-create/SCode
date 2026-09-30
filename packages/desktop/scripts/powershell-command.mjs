const POWERSHELL_COMMON_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive"];

const WINDOWS_POWERSHELL_SECURITY_BOOTSTRAP = [
  "$ErrorActionPreference='Stop';",
  "try{",
  "$zcodeSecurityModule=[IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1');",
  "Import-Module -Name $zcodeSecurityModule -Force -ErrorAction Stop;",
  "}catch{",
  "[Console]::Error.WriteLine(('Windows PowerShell Security module load failed: {0}' -f $_.Exception.Message));",
  "exit 26;",
  "};",
].join("");

function encodeUtf8Value(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

export function createEncodedPowerShellArgs(script, values = []) {
  // Windows PowerShell 5.1 will spell the ordinary `-Command` subsequent argv back into the command text.
  // They will not be injected into `$args`. Dynamic values are encoded separately first and then put into `-EncodedCommand`, while avoiding
  // Program Files spaces, quotes, or semicolons are parsed into script content by PowerShell.
  const valueBindings = values
    .map(
      (value, index) =>
        `$zcodeArg${index}=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodeUtf8Value(value)}'));`,
    )
    .join("");
  const encodedCommand = Buffer.from(`${valueBindings}${script}`, "utf16le").toString("base64");
  return [...POWERSHELL_COMMON_ARGS, "-EncodedCommand", encodedCommand];
}

export function createWindowsPowerShellSecurityArgs(script, values = []) {
  // Node started by pwsh will inherit the PSModulePath of PowerShell 7 and then start it
  // Windows PowerShell 5.1 may incorrectly discover incompatible Security modules. directly from the current
  // Powershell.exe's PSHOME loads system modules to avoid using external environment variables as the module's root of trust.
  return createEncodedPowerShellArgs(`${WINDOWS_POWERSHELL_SECURITY_BOOTSTRAP}${script}`, values);
}
